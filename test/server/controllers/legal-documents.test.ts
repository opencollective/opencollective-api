import { expect } from 'chai';
import config from 'config';
import type { Request, Response } from 'express';
import sinon from 'sinon';

import LegalDocumentsController from '../../../server/controllers/legal-documents';
import { idEncode } from '../../../server/graphql/v2/identifiers';
import * as LibS3 from '../../../server/lib/awsS3';
import { getTaxFormsS3Bucket } from '../../../server/lib/tax-forms';
import { TwoFactorAuthenticationHeader } from '../../../server/lib/two-factor-authentication/lib';
import TOTPLib from '../../../server/lib/two-factor-authentication/totp';
import { Collective, LegalDocument, RequiredLegalDocument, User } from '../../../server/models';
import { LEGAL_DOCUMENT_TYPE } from '../../../server/models/LegalDocument';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import {
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeLegalDocument,
  fakeOpenCollectiveS3URL,
  fakePayoutMethod,
  fakeUser,
} from '../../test-helpers/fake-data';
import { makeRequest } from '../../utils';

const getResStub = () => {
  return {
    send: sinon.stub().returnsThis(),
    status: sinon.stub().returnsThis(),
    set: sinon.stub().returnsThis(),
  };
};

describe('server/controllers/legal-documents', () => {
  let sandbox;

  before(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('download', () => {
    it('should return 401 if not logged in', async () => {
      const req = makeRequest() as unknown as Request;
      const res = getResStub();
      await LegalDocumentsController.download(req, res as Response);
      expect(res.status.calledOnce).to.be.true;
      expect(res.send.calledOnce).to.be.true;
      expect(res.status.firstCall.args[0]).to.equal(401);
      expect(res.send.firstCall.args[0]).to.deep.equal({ message: 'Unauthorized' });
    });

    it('should return 400 if invalid id', async () => {
      const req = makeRequest(await fakeUser()) as unknown as Request;
      const res = getResStub();
      req.params = { id: 'invalid-id' };
      await LegalDocumentsController.download(req, res as Response);
      expect(res.status.calledOnce).to.be.true;
      expect(res.send.calledOnce).to.be.true;
      expect(res.status.firstCall.args[0]).to.equal(400);
      expect(res.send.firstCall.args[0]).to.deep.equal({ message: 'Invalid id' });
    });

    it('should return 404 if legal document not found', async () => {
      const req = makeRequest(await fakeUser()) as unknown as Request;
      const res = getResStub();
      req.params = { id: idEncode(12346789, 'legal-document') };
      await LegalDocumentsController.download(req, res as Response);
      expect(res.status.calledOnce).to.be.true;
      expect(res.send.calledOnce).to.be.true;
      expect(res.status.firstCall.args[0]).to.equal(404);
      expect(res.send.firstCall.args[0]).to.deep.equal({ message: 'Legal document not found' });
    });

    it('should return 403 if not admin of collective', async () => {
      const randomUser = await fakeUser();
      await randomUser.populateRoles();
      const legalDocument = await fakeLegalDocument();
      const req = makeRequest(randomUser) as unknown as Request;
      const res = getResStub();
      req.params = { id: idEncode(legalDocument.id, 'legal-document') };
      await LegalDocumentsController.download(req, res as Response);
      expect(res.status.calledOnce).to.be.true;
      expect(res.send.calledOnce).to.be.true;
      expect(res.status.firstCall.args[0]).to.equal(403);
      expect(res.send.firstCall.args[0]).to.deep.equal({ message: 'Unauthorized' });
    });

    it('should return 403 even if admin of collective', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective({ admin: user });
      await user.populateRoles();
      const legalDocument = await fakeLegalDocument({
        CollectiveId: collective.id,
        documentLink: fakeOpenCollectiveS3URL({ bucket: getTaxFormsS3Bucket(), key: 'file.pdf' }),
      });
      const req = makeRequest(user) as unknown as Request;
      const res = getResStub();
      req.params = { id: idEncode(legalDocument.id, 'legal-document') };
      await LegalDocumentsController.download(req, res as Response);
      expect(res.status.calledOnce).to.be.true;
      expect(res.send.calledOnce).to.be.true;
      expect(res.status.firstCall.args[0]).to.equal(403);
      expect(res.send.firstCall.args[0]).to.deep.equal({ message: 'Unauthorized' });
    });

    it('should return 403 even if admin of a host that do not have access to the document', async () => {
      const user = await fakeUser();
      const anotherHost = await fakeActiveHost({ admin: user });
      await user.populateRoles();

      // Connect host to the tax form system
      await RequiredLegalDocument.create({
        HostCollectiveId: anotherHost.id,
        documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
      });

      // Add a legal document somewhere else
      const legalDocument = await fakeLegalDocument({
        documentLink: fakeOpenCollectiveS3URL({ bucket: config.helloworks.aws.s3.bucket, key: 'file.pdf' }),
      });
      const req = makeRequest(user) as unknown as Request;
      const res = getResStub();
      req.params = { id: idEncode(legalDocument.id, 'legal-document') };
      await LegalDocumentsController.download(req, res as Response);
      expect(res.status.calledOnce).to.be.true;
      expect(res.send.calledOnce).to.be.true;
      expect(res.status.firstCall.args[0]).to.equal(403);
      expect(res.send.firstCall.args[0]).to.deep.equal({ message: 'Unauthorized' });
    });

    describe('with the right permissions', () => {
      let hostAdmin: User, host: Collective, payee: User, legalDocument: LegalDocument;

      before(async () => {
        hostAdmin = await fakeUser({ twoFactorAuthToken: 'test' });
        host = await fakeActiveHost({ admin: hostAdmin, data: { REQUIRE_2FA_FOR_ADMINS: true } });
        const collective = await fakeCollective({ HostCollectiveId: host.id, isActive: true });
        await hostAdmin.populateRoles();
        await RequiredLegalDocument.create({
          HostCollectiveId: host.id,
          documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
        });

        // Add a payee an an expense subject to tax form
        payee = await fakeUser();
        const payoutMethod = await fakePayoutMethod({
          type: PayoutMethodTypes.OTHER,
          CollectiveId: payee.CollectiveId,
        });

        await fakeExpense({
          type: 'INVOICE',
          CollectiveId: collective.id,
          FromCollectiveId: payee.CollectiveId,
          PayoutMethodId: payoutMethod.id, // Need to make sure we're not using PayPal, as PayPal expenses are not subject to tax form
          status: 'APPROVED',
          totalAmount: 1000e2,
          currency: 'USD',
        });

        // Add a legal document
        legalDocument = await fakeLegalDocument({
          CollectiveId: payee.CollectiveId,
          documentLink: fakeOpenCollectiveS3URL({ bucket: config.helloworks.aws.s3.bucket, key: 'file.pdf' }),
        });
      });

      it('should return 403 if document cannot be downloaded', async () => {
        const externallyHostedLegalDocument = await fakeLegalDocument({
          documentLink: 'https://example.com', // Not a S3 link => cannot download
          CollectiveId: payee.CollectiveId,
        });

        const req = makeRequest(hostAdmin) as unknown as Request;
        const res = getResStub();
        req.params = { id: idEncode(externallyHostedLegalDocument.id, 'legal-document') };
        await LegalDocumentsController.download(req, res as Response);
        expect(res.status.calledOnce).to.be.true;
        expect(res.send.calledOnce).to.be.true;
        expect(res.status.firstCall.args[0]).to.equal(403);
        expect(res.send.firstCall.args[0]).to.deep.equal({ message: 'Document cannot be downloaded' });
      });

      it('throws if 2FA is not enabled on the admin account', async () => {
        const hostAdminWithout2FA = await fakeUser();
        await host.addUserWithRole(hostAdminWithout2FA, 'ADMIN');
        await hostAdminWithout2FA.populateRoles();

        const req = makeRequest(hostAdminWithout2FA) as unknown as Request;
        const res = getResStub();
        req.params = { id: idEncode(legalDocument.id, 'legal-document') };
        await LegalDocumentsController.download(req, res as Response);
        expect(res.status.calledOnce).to.be.true;
        expect(res.send.calledOnce).to.be.true;
        expect(res.status.firstCall.args[0]).to.equal(403);
        expect(res.send.firstCall.args[0]).to.deep.equal({ message: 'Two-factor authentication required' });
      });

      it('must provide 2FA', async () => {
        const encryptedContent = LegalDocument.encrypt(Buffer.from('content'));
        sandbox.stub(LibS3, 'getFileFromS3').resolves(encryptedContent);
        const req = makeRequest(hostAdmin) as unknown as Request;
        const res = getResStub();
        req.params = { id: idEncode(legalDocument.id, 'legal-document') };
        await LegalDocumentsController.download(req, res as Response);
        expect(res.status.calledOnce).to.be.true;
        expect(res.send.calledOnce).to.be.true;
        expect(res.status.firstCall.args[0]).to.equal(401);
        expect(res.send.firstCall.args[0]).to.deep.equal({
          authenticationOptions: {},
          message: 'Two-factor authentication required',
          supportedMethods: ['totp', 'recovery_code'],
        });
      });

      it('should reject invalid 2FA codes', async () => {
        const encryptedContent = LegalDocument.encrypt(Buffer.from('content'));
        sandbox.stub(LibS3, 'getFileFromS3').resolves(encryptedContent);
        const req = makeRequest(hostAdmin) as unknown as Request;
        req.headers[TwoFactorAuthenticationHeader] = `totp 123456`;
        const res = getResStub();
        req.params = { id: idEncode(legalDocument.id, 'legal-document') };
        await LegalDocumentsController.download(req, res as Response);
        expect(res.status.calledOnce).to.be.true;
        expect(res.send.calledOnce).to.be.true;
        expect(res.status.firstCall.args[0]).to.equal(401);
        expect(res.send.firstCall.args[0]).to.deep.equal({ message: 'Two-factor authentication code is invalid' });
      });

      it('should decrypt and download file when valid 2FA is provided', async () => {
        const encryptedContent = LegalDocument.encrypt(Buffer.from('content'));
        sandbox.stub(LibS3, 'getFileFromS3').resolves(encryptedContent);
        const req = makeRequest(hostAdmin) as unknown as Request;
        sandbox.stub(TOTPLib, 'validateToken').resolves(true);
        req.headers[TwoFactorAuthenticationHeader] = `totp 123456`;
        const res = getResStub();
        req.params = { id: idEncode(legalDocument.id, 'legal-document') };
        await LegalDocumentsController.download(req, res as Response);
        expect(res.set.calledOnce).to.be.true;
        expect(res.send.calledOnce).to.be.true;
        expect(res.set.firstCall.args[0]).to.equal('Content-Type');
        expect(res.set.firstCall.args[1]).to.equal('application/pdf');
        expect(res.send.firstCall.args[0].toString()).to.equal('content');
      });
    });
  });
});
