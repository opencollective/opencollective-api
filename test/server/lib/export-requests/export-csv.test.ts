import axios from 'axios';
import { expect } from 'chai';
import { Readable } from 'node:stream';
import sinon from 'sinon';

import { processTransactionsRequest } from '../../../../server/lib/export-requests/export-csv';
import { UploadedFile } from '../../../../server/models';
import { ExportRequestStatus } from '../../../../server/models/ExportRequest';
import { fakeExportRequest, fakeUploadedFile, fakeUser } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('server/lib/export-requests/export-csv', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(async () => {
    await resetTestDB();
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('processTransactionsRequest', () => {
    it('should successfully process a transactions export request', async () => {
      // Create test data
      const user = await fakeUser();
      const exportRequest = await fakeExportRequest({
        CreatedByUserId: user.id,
      });

      // Create a fake uploaded file
      const uploadedFile = await fakeUploadedFile({
        CreatedByUserId: user.id,
      });

      // Mock the CSV stream response from axios
      const csvData = 'effectiveDate,legacyId,description\n2024-01-01,123,Test Transaction\n';
      const mockStream = Readable.from([csvData]);

      // Stub axios.get to return our mock stream
      const axiosGetStub = sandbox.stub(axios, 'get').resolves({
        data: mockStream,
        status: 200,
        statusText: 'OK',
        headers: {},
      } as any);

      // Stub UploadedFile.uploadStream to return our fake uploaded file
      const uploadStreamStub = sandbox.stub(UploadedFile, 'uploadStream').resolves(uploadedFile);

      // Create abort controller
      const abortController = new AbortController();

      // Execute the function
      await processTransactionsRequest(exportRequest, abortController.signal);

      // Verify axios.get was called with correct parameters
      expect(axiosGetStub.calledOnce).to.be.true;
      const axiosCall = axiosGetStub.getCall(0);
      expect(axiosCall.args[1]).to.have.property('responseType', 'stream');
      expect(axiosCall.args[1].headers).to.have.property('Authorization');

      // Verify UploadedFile.uploadStream was called
      expect(uploadStreamStub.calledOnce).to.be.true;
      const uploadCall = uploadStreamStub.getCall(0);
      expect(uploadCall.args[1]).to.equal('TRANSACTIONS_CSV_EXPORT');
      expect(uploadCall.args[2].id).to.equal(user.id);
      expect(uploadCall.args[3]).to.have.property('mimetype', 'text/csv');

      // Verify the export request was updated
      await exportRequest.reload();
      expect(exportRequest.status).to.equal(ExportRequestStatus.COMPLETED);
      expect(exportRequest.UploadedFileId).to.equal(uploadedFile.id);
    });

    it('should pass the authorization header with API token', async () => {
      // Create test data
      const user = await fakeUser();
      const exportRequest = await fakeExportRequest({
        CreatedByUserId: user.id,
      });

      const uploadedFile = await fakeUploadedFile({
        CreatedByUserId: user.id,
      });

      const mockStream = Readable.from(['test data']);
      const axiosGetStub = sandbox.stub(axios, 'get').resolves({
        data: mockStream,
        status: 200,
        statusText: 'OK',
        headers: {},
      } as any);

      sandbox.stub(UploadedFile, 'uploadStream').resolves(uploadedFile);

      const abortController = new AbortController();
      await processTransactionsRequest(exportRequest, abortController.signal);

      // Verify the Authorization header is present
      const axiosCall = axiosGetStub.getCall(0);
      expect(axiosCall.args[1].headers).to.have.property('Authorization');
      expect(axiosCall.args[1].headers.Authorization).to.include('Bearer');
    });

    it('should create uploaded file with correct parameters', async () => {
      // Create test data
      const user = await fakeUser();
      const exportRequest = await fakeExportRequest({
        CreatedByUserId: user.id,
      });

      const uploadedFile = await fakeUploadedFile({
        CreatedByUserId: user.id,
      });

      const mockStream = Readable.from(['test data']);
      sandbox.stub(axios, 'get').resolves({
        data: mockStream,
        status: 200,
        statusText: 'OK',
        headers: {},
      } as any);

      const uploadStreamStub = sandbox.stub(UploadedFile, 'uploadStream').resolves(uploadedFile);

      const abortController = new AbortController();
      await processTransactionsRequest(exportRequest, abortController.signal);

      // Verify upload parameters
      expect(uploadStreamStub.calledOnce).to.be.true;
      const [stream, kind, uploadUser, options] = uploadStreamStub.getCall(0).args;

      expect(kind).to.equal('TRANSACTIONS_CSV_EXPORT');
      expect(uploadUser.id).to.equal(user.id);
      expect(options).to.have.property('mimetype', 'text/csv');
      expect(stream).to.be.an.instanceof(Readable);
    });

    it('should handle stream errors', async () => {
      // Create test data
      const user = await fakeUser();
      const exportRequest = await fakeExportRequest({
        CreatedByUserId: user.id,
      });

      const mockStream = Readable.from(['test data']);
      sandbox.stub(axios, 'get').resolves({
        data: mockStream,
        status: 200,
        statusText: 'OK',
        headers: {},
      } as any);

      // Mock upload to fail
      const uploadError = new Error('Upload failed to S3');
      const uploadStreamStub = sandbox.stub(UploadedFile, 'uploadStream').rejects(uploadError);

      const abortController = new AbortController();

      // Execute and expect it to throw
      try {
        await processTransactionsRequest(exportRequest, abortController.signal);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('Upload failed to S3');
      }

      await exportRequest.reload();
      expect(exportRequest.status).to.not.equal(ExportRequestStatus.COMPLETED);
      // Verify upload was attempted
      expect(uploadStreamStub.calledOnce).to.be.true;
    });
  });
});
