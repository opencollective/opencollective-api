import { expect } from 'chai';
import moment from 'moment';
import sinon from 'sinon';

import { cleanupExpiredExports } from '../../../cron/daily/97-cleanup-expired-export-requests';
import * as awsS3 from '../../../server/lib/awsS3';
import models from '../../../server/models';
import { ExportRequestStatus, ExportRequestTypes } from '../../../server/models/ExportRequest';
import { fakeCollective, fakeExportRequest, fakeUploadedFile, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('cron/daily/97-cleanup-expired-export-requests', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(async () => {
    await resetTestDB();
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('cleanupExpiredExports', () => {
    it('should clean up expired export requests', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();

      // Create an expired export request
      const uploadedFile = await fakeUploadedFile({ CreatedByUserId: user.id });
      const expiredExport = await fakeExportRequest({
        CreatedByUserId: user.id,
        CollectiveId: collective.id,
        type: ExportRequestTypes.TRANSACTIONS,
        status: ExportRequestStatus.COMPLETED,
        UploadedFileId: uploadedFile.id,
        expiresAt: moment().subtract(1, 'day').toDate(),
      });

      // Create a non-expired export request that should not be deleted
      const activeExport = await fakeExportRequest({
        CreatedByUserId: user.id,
        CollectiveId: collective.id,
        type: ExportRequestTypes.TRANSACTIONS,
        status: ExportRequestStatus.COMPLETED,
        expiresAt: moment().add(1, 'day').toDate(),
      });

      // Mock S3 deletion
      const deleteS3Stub = sandbox.stub(awsS3, 'permanentlyDeleteFileFromS3').resolves();
      const parseS3UrlStub = sandbox.stub(awsS3, 'parseS3Url').returns({ bucket: 'test-bucket', key: 'test-key' });

      // Run cleanup
      await cleanupExpiredExports(false);

      // Verify the expired export was marked as EXPIRED
      await expiredExport.reload();
      expect(expiredExport.status).to.equal(ExportRequestStatus.EXPIRED);
      expect(expiredExport.UploadedFileId).to.be.null;

      // Verify the active export was NOT modified
      const stillActiveExport = await models.ExportRequest.findByPk(activeExport.id);
      expect(stillActiveExport).to.not.be.null;
      expect(stillActiveExport.status).to.equal(ExportRequestStatus.COMPLETED);

      // Verify S3 deletion was called for the expired export
      expect(deleteS3Stub.calledOnce).to.be.true;
      expect(parseS3UrlStub.calledOnce).to.be.true;

      // Verify the uploaded file was deleted
      const deletedFile = await models.UploadedFile.findByPk(uploadedFile.id, { paranoid: false });
      expect(deletedFile.deletedAt).to.not.be.null;
    });

    it('should not clean up exports without expiresAt', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();

      // Create an export without expiresAt
      const exportWithoutExpiry = await fakeExportRequest({
        CreatedByUserId: user.id,
        CollectiveId: collective.id,
        type: ExportRequestTypes.TRANSACTIONS,
        status: ExportRequestStatus.COMPLETED,
        expiresAt: null,
      });

      // Mock S3 deletion
      const deleteS3Stub = sandbox.stub(awsS3, 'permanentlyDeleteFileFromS3').resolves();

      // Run cleanup
      await cleanupExpiredExports(false);

      // Verify the export was NOT modified
      const stillActiveExport = await models.ExportRequest.findByPk(exportWithoutExpiry.id);
      expect(stillActiveExport).to.not.be.null;
      expect(stillActiveExport.status).to.equal(ExportRequestStatus.COMPLETED);

      // Verify S3 deletion was not called
      expect(deleteS3Stub.called).to.be.false;
    });

    it('should not clean up non-completed exports', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();

      // Create a failed export that has expired
      const failedExport = await fakeExportRequest({
        CreatedByUserId: user.id,
        CollectiveId: collective.id,
        type: ExportRequestTypes.TRANSACTIONS,
        status: ExportRequestStatus.FAILED,
        expiresAt: moment().subtract(1, 'day').toDate(),
      });

      // Mock S3 deletion
      const deleteS3Stub = sandbox.stub(awsS3, 'permanentlyDeleteFileFromS3').resolves();

      // Run cleanup
      await cleanupExpiredExports(false);

      // Verify the failed export was NOT modified
      const stillExistingExport = await models.ExportRequest.findByPk(failedExport.id);
      expect(stillExistingExport).to.not.be.null;
      expect(stillExistingExport.status).to.equal(ExportRequestStatus.FAILED);

      // Verify S3 deletion was not called
      expect(deleteS3Stub.called).to.be.false;
    });

    it('should work in dry run mode without making changes', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();

      // Create an expired export request
      const uploadedFile = await fakeUploadedFile({ CreatedByUserId: user.id });
      const expiredExport = await fakeExportRequest({
        CreatedByUserId: user.id,
        CollectiveId: collective.id,
        type: ExportRequestTypes.TRANSACTIONS,
        status: ExportRequestStatus.COMPLETED,
        UploadedFileId: uploadedFile.id,
        expiresAt: moment().subtract(1, 'day').toDate(),
      });

      // Mock S3 deletion
      const deleteS3Stub = sandbox.stub(awsS3, 'permanentlyDeleteFileFromS3').resolves();

      // Run cleanup in dry run mode
      await cleanupExpiredExports(true);

      // Verify the export was NOT modified
      await expiredExport.reload();
      expect(expiredExport.status).to.equal(ExportRequestStatus.COMPLETED);
      expect(expiredExport.UploadedFileId).to.equal(uploadedFile.id);

      // Verify S3 deletion was NOT called in dry run mode
      expect(deleteS3Stub.called).to.be.false;
    });

    it('should handle exports without uploaded files', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();

      // Create an expired export request without an uploaded file
      const expiredExport = await fakeExportRequest({
        CreatedByUserId: user.id,
        CollectiveId: collective.id,
        type: ExportRequestTypes.TRANSACTIONS,
        status: ExportRequestStatus.COMPLETED,
        UploadedFileId: null,
        expiresAt: moment().subtract(1, 'day').toDate(),
      });

      // Mock S3 deletion
      const deleteS3Stub = sandbox.stub(awsS3, 'permanentlyDeleteFileFromS3').resolves();

      // Run cleanup
      await cleanupExpiredExports(false);

      // Verify the export was marked as EXPIRED
      await expiredExport.reload();
      expect(expiredExport.status).to.equal(ExportRequestStatus.EXPIRED);

      // Verify S3 deletion was not called since there's no file
      expect(deleteS3Stub.called).to.be.false;
    });

    it('should not process already expired exports', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();

      // Create an export that is already marked as EXPIRED
      const alreadyExpiredExport = await fakeExportRequest({
        CreatedByUserId: user.id,
        CollectiveId: collective.id,
        type: ExportRequestTypes.TRANSACTIONS,
        status: ExportRequestStatus.EXPIRED,
        expiresAt: moment().subtract(1, 'day').toDate(),
        UploadedFileId: null,
      });

      // Mock S3 deletion
      const deleteS3Stub = sandbox.stub(awsS3, 'permanentlyDeleteFileFromS3').resolves();

      // Run cleanup
      await cleanupExpiredExports(false);

      // Verify the export was NOT modified (already EXPIRED)
      await alreadyExpiredExport.reload();
      expect(alreadyExpiredExport.status).to.equal(ExportRequestStatus.EXPIRED);

      // Verify S3 deletion was not called
      expect(deleteS3Stub.called).to.be.false;
    });
  });
});
