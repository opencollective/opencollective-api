import { expect } from 'chai';
import gql from 'fake-tag';
import { describe, it } from 'mocha';
import moment from 'moment';
import { createSandbox } from 'sinon';
import { decodeBase64 } from 'tweetnacl-util';

import { US_TAX_FORM_VALIDITY_IN_YEARS } from '../../../../../server/constants/tax-form';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import emailLib from '../../../../../server/lib/email';
import * as PDFLib from '../../../../../server/lib/pdf';
import * as TaxFormLib from '../../../../../server/lib/tax-forms';
import models, { LegalDocument } from '../../../../../server/models';
import { LEGAL_DOCUMENT_TYPE } from '../../../../../server/models/LegalDocument';
import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import {
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeLegalDocument,
  fakeOpenCollectiveS3URL,
  fakePayoutMethod,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, waitForCondition } from '../../../../utils';

describe('LegalDocumentsMutations', () => {
  let sandbox, sendEmailSpy, host, hostAdmin, collective, collectiveAdmin;

  before(async () => {
    sandbox = createSandbox();
    sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
    collectiveAdmin = await fakeUser();
    hostAdmin = await fakeUser();
    host = await fakeActiveHost({ name: 'Host', admin: hostAdmin });
    await host.createRequiredLegalDocument({ type: LEGAL_DOCUMENT_TYPE.US_TAX_FORM });
    collective = await fakeCollective({ name: 'Super Org', admin: collectiveAdmin, HostCollectiveId: host.id });
  });

  after(() => sandbox.restore());

  afterEach(() => {
    sendEmailSpy.resetHistory();
  });

  describe('submitLegalDocument', () => {
    let validParams;
    const submitLegalDocumentMutation = gql`
      mutation SubmitLegalDocument($account: AccountReferenceInput!, $type: LegalDocumentType!, $formData: JSON!) {
        submitLegalDocument(account: $account, type: $type, formData: $formData) {
          id
          status
          service
          type
          updatedAt
        }
      }
    `;

    before(() => {
      sandbox.stub(PDFLib, 'getUSTaxFormPdf').resolves('PDF_CONTENT');
      sandbox.stub(TaxFormLib, 'encryptAndUploadTaxFormToS3').resolves({
        url: fakeOpenCollectiveS3URL({ bucket: TaxFormLib.getTaxFormsS3Bucket(), key: 'path/to/filename.pdf' }),
      });

      validParams = {
        account: { legacyId: collective.id },
        type: 'US_TAX_FORM',
        formData: { formType: 'W9' },
      };
    });

    afterEach(async () => {
      await models.LegalDocument.destroy({ where: { CollectiveId: collective.id } });
    });

    it('must be authenticated', async () => {
      const { errors } = await graphqlQueryV2(submitLegalDocumentMutation, validParams);
      expect(errors).to.exist;
      expect(errors[0].message).to.equal('You need to be logged in to submit a legal document');
    });

    it('must be an admin of collective', async () => {
      const randomUser = await fakeUser();
      const { errors } = await graphqlQueryV2(submitLegalDocumentMutation, validParams, randomUser);
      expect(errors).to.exist;
      expect(errors[0].message).to.equal('You do not have permission to submit a legal document for this account');
    });

    it('does not work if there is no request for this document', async () => {
      const { errors } = await graphqlQueryV2(submitLegalDocumentMutation, validParams, collectiveAdmin);
      expect(errors).to.exist;
      expect(errors[0].message).to.equal('No tax form request found for this account');
    });

    it('does not work if we already have a valid tax form', async () => {
      await models.LegalDocument.create({
        CollectiveId: collective.id,
        documentType: 'US_TAX_FORM',
        requestStatus: 'RECEIVED',
        year: new Date().getFullYear(),
      });
      const { errors } = await graphqlQueryV2(submitLegalDocumentMutation, validParams, collectiveAdmin);
      expect(errors).to.exist;
      expect(errors[0].message).to.equal('A tax form has already been submitted for this account');
    });

    it('must provide a valid form type', async () => {
      const { errors } = await graphqlQueryV2(
        submitLegalDocumentMutation,
        {
          ...validParams,
          formData: { formType: 'INVALID' },
        },
        collectiveAdmin,
      );
      expect(errors).to.exist;
      expect(errors[0].message).to.equal('Invalid form type');
    });

    it('works if there is a request for this document', async () => {
      const ld = await models.LegalDocument.create({
        CollectiveId: collective.id,
        documentType: 'US_TAX_FORM',
        requestStatus: 'REQUESTED',
        year: new Date().getFullYear(),
      });

      const result = await graphqlQueryV2(submitLegalDocumentMutation, validParams, collectiveAdmin);

      // Check response
      expect(result.errors).to.not.exist;
      expect(result.data.submitLegalDocument).to.have.property('id');
      expect(result.data.submitLegalDocument).to.have.property('status', 'RECEIVED');
      expect(result.data.submitLegalDocument).to.have.property('service', 'OPENCOLLECTIVE');

      // Check legal document
      await ld.reload();
      expect(ld.documentLink).to.match(/path\/to\/filename.pdf$/);
      expect(ld.data.valuesHash).to.exist;
      expect(ld.data.encryptedFormData).to.exist;
      expect(
        JSON.parse(LegalDocument.decrypt(Buffer.from(decodeBase64(ld.data.encryptedFormData))).toString()),
      ).to.deep.equal({ formType: 'W9' });

      // Check activity
      const activity = await models.Activity.findOne({
        where: {
          type: 'taxform.received',
          data: { document: { id: ld.id } },
        },
      });

      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(collective.id);
      expect(activity.UserId).to.equal(collectiveAdmin.id);
      expect(activity.FromCollectiveId).to.equal(collectiveAdmin.CollectiveId);
      expect(activity.data.valuesHash).to.equal(ld.data.valuesHash);
      expect(activity.data.type).to.equal('W9');
      expect(activity.data.service).to.equal('OPENCOLLECTIVE');

      // Check sent email (incl. PDF attachment)
      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.firstCall.args[0]).to.equal(collectiveAdmin.email);
      expect(sendEmailSpy.firstCall.args[1]).to.equal('Your copy of Open Collective Tax Form');
      expect(sendEmailSpy.firstCall.args[2]).to.include('Thank you for completing');
      expect(sendEmailSpy.firstCall.args[2]).to.include("Super Org's");
      expect(sendEmailSpy.firstCall.args[2]).to.include('tax form on Open Collective');
      expect(sendEmailSpy.firstCall.args[3].attachments).to.have.length(1);
      expect(sendEmailSpy.firstCall.args[3].attachments[0].filename).to.equal('filename.pdf');
      expect(sendEmailSpy.firstCall.args[3].attachments[0].content.toString()).to.equal('PDF_CONTENT');
    });

    it('works if the previous legal document is expired', async () => {
      await models.LegalDocument.create({
        CollectiveId: collective.id,
        documentType: 'US_TAX_FORM',
        requestStatus: 'RECEIVED',
        year: new Date().getFullYear() - US_TAX_FORM_VALIDITY_IN_YEARS - 1,
      });

      const result = await graphqlQueryV2(submitLegalDocumentMutation, validParams, collectiveAdmin);

      // Check response
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.submitLegalDocument).to.have.property('id');
      expect(result.data.submitLegalDocument).to.have.property('status', 'RECEIVED');
      expect(result.data.submitLegalDocument).to.have.property('service', 'OPENCOLLECTIVE');
    });
  });

  describe('editLegalDocumentStatus', () => {
    const editLegalDocumentStatusMutation = gql`
      mutation EditLegalDocumentStatus(
        $id: String!
        $status: LegalDocumentRequestStatus!
        $host: AccountReferenceInput!
        $message: String
        $file: Upload
      ) {
        editLegalDocumentStatus(id: $id, status: $status, host: $host, message: $message, file: $file) {
          id
          status
        }
      }
    `;

    it('must be authenticated', async () => {
      const legalDocument = await fakeLegalDocument({ CollectiveId: collective.id });
      const { errors } = await graphqlQueryV2(editLegalDocumentStatusMutation, {
        id: idEncode(legalDocument.id, IDENTIFIER_TYPES.LEGAL_DOCUMENT),
        host: { id: idEncode(host.id, IDENTIFIER_TYPES.ACCOUNT) },
        status: 'INVALID',
      });
      expect(errors).to.exist;
      expect(errors[0].message).to.equal('You need to be logged in to manage hosted accounts.');
    });

    it('must be an admin of collective', async () => {
      const randomUser = await fakeUser();
      const legalDocument = await fakeLegalDocument({ CollectiveId: collective.id });
      const { errors } = await graphqlQueryV2(
        editLegalDocumentStatusMutation,
        {
          id: idEncode(legalDocument.id, IDENTIFIER_TYPES.LEGAL_DOCUMENT),
          host: { id: idEncode(host.id, IDENTIFIER_TYPES.ACCOUNT) },
          status: 'INVALID',
        },
        randomUser,
      );
      expect(errors).to.exist;
      expect(errors[0].message).to.equal('You do not have permission to edit legal documents for this host');
    });

    it('must exist', async () => {
      const { errors } = await graphqlQueryV2(
        editLegalDocumentStatusMutation,
        {
          id: idEncode(999999, IDENTIFIER_TYPES.LEGAL_DOCUMENT),
          host: { id: idEncode(host.id, IDENTIFIER_TYPES.ACCOUNT) },
          status: 'INVALID',
        },
        hostAdmin,
      );
      expect(errors).to.exist;
      expect(errors[0].message).to.equal('Legal document not found');
    });

    it('must not be expired', async () => {
      const payee = await fakeUser();
      const payoutMethod = await fakePayoutMethod({
        CollectiveId: payee.CollectiveId,
        type: PayoutMethodTypes.BANK_ACCOUNT,
      });
      const expense = await fakeExpense({
        type: 'INVOICE',
        status: 'APPROVED',
        CollectiveId: host.id,
        amount: 1000e2,
        PayoutMethodId: payoutMethod.id,
        incurredAt: moment().subtract(US_TAX_FORM_VALIDITY_IN_YEARS + 1, 'year'),
      });
      const legalDocument = await fakeLegalDocument({
        documentType: 'US_TAX_FORM',
        requestStatus: 'RECEIVED',
        CollectiveId: expense.FromCollectiveId,
        year: new Date().getFullYear() - US_TAX_FORM_VALIDITY_IN_YEARS - 1,
      });

      const { errors } = await graphqlQueryV2(
        editLegalDocumentStatusMutation,
        {
          id: idEncode(legalDocument.id, IDENTIFIER_TYPES.LEGAL_DOCUMENT),
          host: { id: idEncode(host.id, IDENTIFIER_TYPES.ACCOUNT) },
          status: 'INVALID',
        },
        hostAdmin,
      );
      expect(errors).to.exist;
      expect(errors[0].message).to.equal('Legal document is expired');
    });

    it('can invalidate', async () => {
      const payee = await fakeUser();
      const payoutMethod = await fakePayoutMethod({
        CollectiveId: payee.CollectiveId,
        type: PayoutMethodTypes.BANK_ACCOUNT,
      });
      const expense = await fakeExpense({
        type: 'INVOICE',
        status: 'APPROVED',
        CollectiveId: host.id,
        FromCollectiveId: payee.CollectiveId,
        amount: 1000e2,
        PayoutMethodId: payoutMethod.id,
      });
      const legalDocument = await fakeLegalDocument({
        documentType: 'US_TAX_FORM',
        requestStatus: 'RECEIVED',
        CollectiveId: expense.FromCollectiveId,
        year: new Date().getFullYear(),
      });
      const result = await graphqlQueryV2(
        editLegalDocumentStatusMutation,
        {
          id: idEncode(legalDocument.id, IDENTIFIER_TYPES.LEGAL_DOCUMENT),
          host: { id: idEncode(host.id, IDENTIFIER_TYPES.ACCOUNT) },
          status: 'INVALID',
          message: 'Bad Bad not Good',
        },
        hostAdmin,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editLegalDocumentStatus).to.have.property('status', 'INVALID');
      await waitForCondition(() => sendEmailSpy.callCount === 1);
      expect(sendEmailSpy.firstCall.args[0]).to.equal(payee.email);
      expect(sendEmailSpy.firstCall.args[1]).to.equal('Action required: Your tax form has been marked as invalid');
      expect(sendEmailSpy.firstCall.args[2]).to.include('Bad Bad not Good');
    });
  });
});
