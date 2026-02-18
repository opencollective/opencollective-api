import '../../server/env';

import { parseS3Url, permanentlyDeleteFileFromS3 } from '../../server/lib/awsS3';
import logger from '../../server/lib/logger';
import { reportErrorToSentry } from '../../server/lib/sentry';
import { parseToBoolean } from '../../server/lib/utils';
import models, { Op, sequelize } from '../../server/models';
import { ExportRequestStatus } from '../../server/models/ExportRequest';
import { runCronJob } from '../utils';

/**
 * Clean up expired export requests by deleting associated files from S3
 * and marking the export request as EXPIRED.
 */
export const cleanupExpiredExports = async (isDryRun = false) => {
  const transaction = await sequelize.transaction();

  try {
    // Find all completed exports that have expired
    const expiredExports = await models.ExportRequest.findAll({
      where: {
        status: ExportRequestStatus.COMPLETED,
        expiresAt: {
          [Op.not]: null,
          [Op.lte]: new Date(),
        },
      },
      include: [
        {
          model: models.UploadedFile,
          as: 'uploadedFile',
          required: false,
        },
      ],
      transaction,
    });

    logger.info(`Found ${expiredExports.length} expired export requests to clean up`);

    for (const exportRequest of expiredExports) {
      try {
        // Delete associated uploaded file from S3 and database
        if (exportRequest.uploadedFile) {
          if (!isDryRun) {
            const { bucket, key } = parseS3Url(exportRequest.uploadedFile.getDataValue('url'));
            await permanentlyDeleteFileFromS3(bucket, key);
            await exportRequest.uploadedFile.destroy({ transaction });
            logger.info(
              `Deleted uploaded file ${exportRequest.uploadedFile.id} for export request ${exportRequest.id}`,
            );
          } else {
            logger.info(
              `Would delete uploaded file ${exportRequest.uploadedFile.id} for export request ${exportRequest.id}`,
            );
          }
        }

        // Update status to EXPIRED instead of soft-deleting
        if (!isDryRun) {
          await exportRequest.update({ status: ExportRequestStatus.EXPIRED, UploadedFileId: null }, { transaction });
          logger.info(`Marked export request ${exportRequest.id} as EXPIRED`);
        } else {
          logger.info(`Would mark export request ${exportRequest.id} as EXPIRED`);
        }
      } catch (error) {
        logger.error(`Error cleaning up export request ${exportRequest.id}:`, error);
        reportErrorToSentry(error);
        // Continue with other exports even if one fails
      }
    }

    if (!isDryRun) {
      logger.info('Committing expired exports cleanup transaction');
      await transaction.commit();
    } else {
      logger.warn('Dry run mode enabled, rolling back transaction');
      await transaction.rollback();
    }
  } catch (error) {
    logger.error('Error during expired exports cleanup:', error);
    await transaction.rollback();
    throw error;
  }
};

if (require.main === module) {
  const isDryRun = parseToBoolean(process.env.DRY_RUN);
  runCronJob('cleanup-expired-export-requests', () => cleanupExpiredExports(isDryRun), 24 * 60 * 60);
}
