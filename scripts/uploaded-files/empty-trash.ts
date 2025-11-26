/**
 * This script assumes that all files still being used have been recorded to the `UploadedFile` table (using `scripts/uploaded-files/record-existing-files.ts`).
 * It will move all files that are in S3 but not in the database to a trash folder by prepending `trash/` to the key.
 */

import '../../server/env';

import config from 'config';
import { maxBy, minBy, round } from 'lodash';
import moment from 'moment';
import PQueue from 'p-queue';

import { listFilesInS3, permanentlyDeleteFileFromS3, S3_TRASH_PREFIX } from '../../server/lib/awsS3';
import logger from '../../server/lib/logger';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const OLDER_THAN = moment().subtract(20, 'months');

const filterObjects = (objects: Awaited<ReturnType<typeof listFilesInS3>>) => {
  return objects.filter(o => o.LastModified < OLDER_THAN.toDate());
};

const main = async () => {
  logger.info('Listing files in trash folder');
  const allObjects = await listFilesInS3(config.aws.s3.bucket, S3_TRASH_PREFIX);
  const filteredObjects = filterObjects(allObjects);
  logger.info(
    `Found ${allObjects.length} files in trash folder, ${filteredObjects.length} older than ${OLDER_THAN.format()} to be deleted`,
  );

  // Actually trash files
  if (!DRY_RUN) {
    const queue = new PQueue({ concurrency: 3 });
    filteredObjects.forEach(o => queue.add(() => permanentlyDeleteFileFromS3(config.aws.s3.bucket, o.Key)));

    // Show progress
    let curFile = 0;
    const logProgress = () => {
      if (curFile++ % 100 === 0) {
        logger.info(
          `Deleted ${curFile}/${filteredObjects.length} files (~${round((curFile / filteredObjects.length) * 100, 2)}%)`,
        );
      }
    };

    queue.on('active', logProgress);

    // Process the queue
    await queue.onIdle();
  } else {
    logger.info('DRY_RUN is enabled, skipping actual trashing of files');
    logger.info('Example of files that would be trashed:');
    filteredObjects.slice(0, 5).forEach(o => logger.info(`- ${JSON.stringify(o)}`));
    const oldestFile = minBy(filteredObjects, 'LastModified');
    const newestFile = maxBy(filteredObjects, 'LastModified');
    logger.info(`Oldest file: ${JSON.stringify(oldestFile)}`);
    logger.info(`Newest file: ${JSON.stringify(newestFile)}`);
  }

  logger.info('Done');
};

if (require.main === module) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
