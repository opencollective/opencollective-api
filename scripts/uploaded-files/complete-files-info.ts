#!/usr/bin/env ./node_modules/.bin/babel-node

import '../../server/env.js';

import { round } from 'lodash-es';
import PQueue from 'p-queue';

import { getFileInfoFromS3 } from '../../server/lib/awsS3.js';
import logger from '../../server/lib/logger.js';
import { parseToBoolean } from '../../server/lib/utils.js';
import UploadedFile, { SUPPORTED_FILE_TYPES } from '../../server/models/UploadedFile.js';

const DRY_RUN = process.env.DRY_RUN ? parseToBoolean(process.env.DRY_RUN) : true;

const completeFilesInfo = async (file: UploadedFile): Promise<void> => {
  // Get file info from S3
  let fileInfo;
  try {
    fileInfo = await getFileInfoFromS3(file.url);
  } catch (e) {
    if (e.code === 'NotFound') {
      logger.warn(`File ${file.url} (${file.kind}) not found on S3, consider deleting it`);
      return;
    } else {
      throw e;
    }
  }

  // Update model
  if (DRY_RUN) {
    logger.info(
      `DRY RUN: Would update file ${file.id} with size ${fileInfo.ContentLength} and type ${fileInfo.ContentType}`,
    );
  } else {
    // Using the static Model.update() method to skip the validations and make sure we can update `createdAt`
    await UploadedFile.update(
      {
        createdAt: fileInfo.LastModified,
        fileSize: fileInfo.ContentLength,
        fileType: fileInfo.ContentType as (typeof SUPPORTED_FILE_TYPES)[number], // This will not be necessarily a supported type, but we still want to record everything
        data: { ...file.data, completedAt: new Date().toISOString() },
      },
      {
        where: { id: file.id, url: file.url },
        validate: false, // Allow any fileType
      },
    );
  }
};

const main = async () => {
  // Please avoid running this script without a `where` condition to avoid updating all files
  const filesToUpdate = await UploadedFile.findAll({
    order: [['id', 'ASC']],
  });

  logger.info(`Found ${filesToUpdate.length} files to update`);

  // Process files concurrently, but limit the number of concurrent requests to S3
  const queue = new PQueue({ concurrency: 50 });
  filesToUpdate.forEach((file, fileIdx) =>
    queue.add(() => {
      const percentage = round(((fileIdx + 1) / filesToUpdate.length) * 100, 2);
      logger.info(`Processing file #${file.id} ${fileIdx + 1}/${filesToUpdate.length} (${percentage}%)`);
      return completeFilesInfo(file);
    }),
  );

  await queue.onIdle();
};

main()
  .then(() => {
    process.exit(0);
  })
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
