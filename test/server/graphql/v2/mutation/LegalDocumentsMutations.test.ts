import { expect } from 'chai';
import gql from 'fake-tag';
import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';
import { decodeBase64 } from 'tweetnacl-util';

import emailLib from '../../../../../server/lib/email';
import * as PDFLib from '../../../../../server/lib/pdf';
import * as TaxFormLib from '../../../../../server/lib/tax-forms';
import models, { LegalDocument } from '../../../../../server/models';
import { fakeCollective, fakeOpenCollectiveS3URL, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

let sandbox, sendEmailSpy, collective, admin;

describe('MemberInvitationMutations', () => {
  before(async () => {
    sandbox = createSandbox();
    sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
    admin = await fakeUser();
    collective = await fakeCollective({ name: 'Super Org', admin });
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
      const { errors } = await graphqlQueryV2(submitLegalDocumentMutation, validParams, admin);
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
      const { errors } = await graphqlQueryV2(submitLegalDocumentMutation, validParams, admin);
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
        admin,
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

      const result = await graphqlQueryV2(submitLegalDocumentMutation, validParams, admin);

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
      expect(activity.UserId).to.equal(admin.id);
      expect(activity.FromCollectiveId).to.equal(admin.CollectiveId);
      expect(activity.data.valuesHash).to.equal(ld.data.valuesHash);
      expect(activity.data.type).to.equal('W9');
      expect(activity.data.service).to.equal('OPENCOLLECTIVE');

      // Check sent email (incl. PDF attachment)
      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.firstCall.args[0]).to.equal(admin.email);
      expect(sendEmailSpy.firstCall.args[1]).to.equal('Your copy of Open Collective Tax Form');
      expect(sendEmailSpy.firstCall.args[2]).to.include('Thank you for completing');
      expect(sendEmailSpy.firstCall.args[2]).to.include("Super Org's");
      expect(sendEmailSpy.firstCall.args[2]).to.include('tax form on Open Collective');
      expect(sendEmailSpy.firstCall.args[3].attachments).to.have.length(1);
      expect(sendEmailSpy.firstCall.args[3].attachments[0].filename).to.equal('filename.pdf');
      expect(sendEmailSpy.firstCall.args[3].attachments[0].content.toString()).to.equal('PDF_CONTENT');
    });
  });
});
