import axios from 'axios';
import { expect } from 'chai';
import { Readable, Stream } from 'node:stream';
import sinon from 'sinon';

import { processTransactionsRequest } from '../../../../server/lib/export-requests/export-csv';
import { runWithTimeout } from '../../../../server/lib/promises';
import { UploadedFile } from '../../../../server/models';
import { ExportRequestStatus } from '../../../../server/models/ExportRequest';
import { fakeExportRequest, fakeUploadedFile, fakeUser } from '../../../test-helpers/fake-data';
import { resetTestDB, waitForCondition } from '../../../utils';

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
      // The worker is the sole writer of `status`: the processor only records the result
      expect(exportRequest.status).to.equal(ExportRequestStatus.ENQUEUED);
      expect(exportRequest.UploadedFileId).to.equal(uploadedFile.id);
      expect(exportRequest.expiresAt).to.not.be.null;
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

    // Resolves like a real S3 upload only once the passed stream is torn down/ended
    const stubUploadSettlingOnStreamTeardown = (uploadedFile: UploadedFile) => {
      let settled = false;
      const stub = sandbox.stub(UploadedFile, 'uploadStream').callsFake(stream => {
        return new Promise(resolve => {
          const settle = () => {
            settled = true;
            resolve(uploadedFile);
          };
          stream.on('close', settle);
          stream.on('finish', settle);
          stream.on('error', settle);
        });
      });
      return { stub, hasSettled: () => settled };
    };

    it('tears down the pass-through stream when the download fails', async () => {
      const user = await fakeUser();
      const exportRequest = await fakeExportRequest({ CreatedByUserId: user.id });
      const uploadedFile = await fakeUploadedFile({ CreatedByUserId: user.id });
      const downloadError = new Error('Download failed');
      sandbox.stub(axios, 'get').rejects(downloadError);
      const upload = stubUploadSettlingOnStreamTeardown(uploadedFile);

      const error = await runWithTimeout(
        processTransactionsRequest(exportRequest, new AbortController().signal),
        3_000,
        'processTransactionsRequest did not settle: the S3 upload is hanging on a stream that never ends',
      ).then(
        () => expect.fail('Should have thrown the download error'),
        err => err,
      );

      expect(error.message).to.equal('Download failed');
      // The pass-through is torn down so the upload settles instead of leaking
      expect(upload.hasSettled()).to.be.true;
      await exportRequest.reload();
      expect(exportRequest.status).to.not.equal(ExportRequestStatus.COMPLETED);
      expect(exportRequest.UploadedFileId).to.be.null;
    });

    it('tears down the pass-through stream when the download stream fails mid-transfer', async () => {
      const user = await fakeUser();
      const exportRequest = await fakeExportRequest({ CreatedByUserId: user.id });
      const uploadedFile = await fakeUploadedFile({ CreatedByUserId: user.id });
      const failingSource = new Stream.Readable({ read() {} });
      sandbox.stub(axios, 'get').resolves({
        data: failingSource,
        status: 200,
        statusText: 'OK',
        headers: {},
      } as any);
      const upload = stubUploadSettlingOnStreamTeardown(uploadedFile);

      const processCall = processTransactionsRequest(exportRequest, new AbortController().signal);
      await waitForCondition(() => upload.stub.calledOnce, { timeout: 4_000 });
      failingSource.destroy(new Error('Connection reset'));

      const error = await runWithTimeout(
        processCall,
        3_000,
        'processTransactionsRequest did not settle: the S3 upload is hanging on a stream that never ends',
      ).then(
        () => expect.fail('Should have thrown the stream error'),
        err => err,
      );

      expect(error.message).to.equal('Connection reset');
      expect(upload.hasSettled()).to.be.true;
    });

    it('propagates the abort signal to the download and upload and removes its listener', async () => {
      const user = await fakeUser();
      const exportRequest = await fakeExportRequest({ CreatedByUserId: user.id });
      const uploadedFile = await fakeUploadedFile({ CreatedByUserId: user.id });

      let rejectDownload: (error: Error) => void;
      const axiosGetStub = sandbox
        .stub(axios, 'get')
        .callsFake(() => new Promise((_, reject) => (rejectDownload = reject)));
      const upload = stubUploadSettlingOnStreamTeardown(uploadedFile);

      const workerAbortController = new AbortController();
      const addEventListenerSpy = sandbox.spy(workerAbortController.signal, 'addEventListener');
      const removeEventListenerSpy = sandbox.spy(workerAbortController.signal, 'removeEventListener');

      const processCall = processTransactionsRequest(exportRequest, workerAbortController.signal);
      await waitForCondition(() => axiosGetStub.calledOnce && upload.stub.calledOnce, { timeout: 4_000 });

      const downloadSignal = axiosGetStub.getCall(0).args[1].signal;
      const uploadAbortController = upload.stub.getCall(0).args[3].abortController;
      expect(downloadSignal.aborted).to.be.false;
      expect(uploadAbortController.signal.aborted).to.be.false;

      workerAbortController.abort();
      expect(downloadSignal.aborted).to.be.true;
      expect(uploadAbortController.signal.aborted).to.be.true;

      // The run settles instead of hanging: reject the download like a canceled request would
      rejectDownload(new Error('Download canceled'));
      await expect(processCall).to.be.rejectedWith('Download canceled');
      expect(upload.hasSettled()).to.be.true;

      // The abort listener is registered once and removed when the run settles
      const abortRegistration = addEventListenerSpy.getCalls().find(call => call.args[0] === 'abort');
      expect(abortRegistration.args[2]).to.have.property('once', true);
      const abortRemoval = removeEventListenerSpy.getCalls().find(call => call.args[0] === 'abort');
      expect(abortRemoval.args[1]).to.equal(abortRegistration.args[1]);
    });
  });
});
