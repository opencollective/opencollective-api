import { expect } from 'chai';
import config from 'config';
import type { Request, Response } from 'express';
import sinon from 'sinon';

import LegalDocumentsController from '../../../server/controllers/legal-documents';
import { idEncode } from '../../../server/graphql/v2/identifiers';
import { fakeCollective, fakeLegalDocument, fakeOpenCollectiveS3URL, fakeUser } from '../../test-helpers/fake-data';
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

    // it('should return 403 if document cannot be downloaded', async () => {
    //   const user = await fakeUser();
    //   const organization = await fakeOrganization({ admin: user });
    //   await user.populateRoles();
    //   const legalDocument = await fakeLegalDocument({
    //     documentLink: 'https://example.com',
    //     CollectiveId: organization.id,
    //   });
    //   const req = makeRequest(user) as unknown as Request;
    //   const res = getResStub();
    //   req.params = { id: idEncode(legalDocument.id, 'legal-document') };
    //   await LegalDocumentsController.download(req, res as Response);
    //   expect(res.status.calledOnce).to.be.true;
    //   expect(res.send.calledOnce).to.be.true;
    //   expect(res.status.firstCall.args[0]).to.equal(403);
    //   expect(res.send.firstCall.args[0]).to.deep.equal({ message: 'Document cannot be downloaded' });
    // });

    // it('must provide 2FA if configured on account', async () => {
    //   const encryptedContent = LegalDocument.encrypt(Buffer.from('content'));
    //   sandbox.stub(LibS3, 'getFileFromS3').resolves(encryptedContent);
    //   const user = await fakeUser({ twoFactorAuthToken: 'test' });

    //   const collective = await fakeCollective({ admin: user });
    //   await user.populateRoles();
    //   const legalDocument = await fakeLegalDocument({
    //     CollectiveId: collective.id,
    //     documentLink: fakeOpenCollectiveS3URL({ bucket: config.helloworks.aws.s3.bucket, key: 'file.pdf' }),
    //   });
    //   const req = makeRequest(user) as unknown as Request;
    //   const res = getResStub();
    //   req.params = { id: idEncode(legalDocument.id, 'legal-document') };
    //   await LegalDocumentsController.download(req, res as Response);
    //   expect(res.status.calledOnce).to.be.true;
    //   expect(res.send.calledOnce).to.be.true;
    //   expect(res.status.firstCall.args[0]).to.equal(401);
    //   expect(res.send.firstCall.args[0]).to.deep.equal({
    //     authenticationOptions: {},
    //     message: 'Two-factor authentication required',
    //     supportedMethods: ['totp', 'recovery_code'],
    //   });
    // });

    // it('should decrypt and download file', async () => {
    //   const encryptedContent = LegalDocument.encrypt(Buffer.from('content'));
    //   sandbox.stub(LibS3, 'getFileFromS3').resolves(encryptedContent);
    //   const user = await fakeUser();
    //   const collective = await fakeCollective({ admin: user });
    //   await user.populateRoles();
    //   const legalDocument = await fakeLegalDocument({
    //     CollectiveId: collective.id,
    //     documentLink: fakeOpenCollectiveS3URL({ bucket: config.helloworks.aws.s3.bucket, key: 'file.pdf' }),
    //   });
    //   const req = makeRequest(user) as unknown as Request;
    //   const res = getResStub();
    //   req.params = { id: idEncode(legalDocument.id, 'legal-document') };
    //   await LegalDocumentsController.download(req, res as Response);
    //   expect(res.set.calledOnce).to.be.true;
    //   expect(res.send.calledOnce).to.be.true;
    //   expect(res.set.firstCall.args[0]).to.equal('Content-Type');
    //   expect(res.set.firstCall.args[1]).to.equal('application/pdf');
    //   expect(res.send.firstCall.args[0].toString()).to.equal('content');
    // });
  });
});
