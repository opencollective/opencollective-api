#!/usr/bin/env ./node_modules/.bin/babel-node

import '../../server/env.js';

import fs from 'fs';

import { S3 } from 'aws-sdk';
import { Command } from 'commander';
import config from 'config';
import moment from 'moment';
import PQueue from 'p-queue';

import { listFilesInS3, S3_TRASH_PREFIX, trashFileFromS3 } from '../../server/lib/awsS3.js';
import logger from '../../server/lib/logger.js';
import { sequelize } from '../../server/models/index.js';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const LOCAL_CACHE_FILE = 'output/s3-files.json';
const IGNORED_FILES = ['robots.txt'];

const getNonTrashedFilesFromS3 = async (ignoreCache: boolean) => {
  let objects: S3.Object[] = [];
  let message;

  if (!ignoreCache && fs.existsSync(LOCAL_CACHE_FILE)) {
    // Load the list from local file if it exists
    objects = JSON.parse(fs.readFileSync(LOCAL_CACHE_FILE, 'utf8'));
    message = `Found ${objects.length} files in local cache`;
  } else {
    // Otherwise fetch all files from S3 and save the list locally (in case we need to restart the script)
    objects = await listFilesInS3(config.aws.s3.bucket);
    message = `Found ${objects.length} files in S3. Saving list to local cache`;
    fs.writeFileSync(LOCAL_CACHE_FILE, JSON.stringify(objects, null, 2));
  }

  const filteredList = objects
    // Filters out files that are already in the trash
    .filter(o => !o.Key.startsWith(S3_TRASH_PREFIX))
    // Filters out files recently uploaded (less than 1 week old to be safe) as they might not have been recorded yet
    .filter(o => moment(o.LastModified).isBefore(moment().subtract(1, 'week')))
    // Some static files are not recorded in the database
    .filter(o => !IGNORED_FILES.includes(o.Key));

  logger.info(`${message} (${filteredList.length} non-trashed/non-ignored files to analyze)`);

  return filteredList;
};

/**
 * S3 encodes all special characters (including `(` and `)`) in the key. We however want to preserve
 * the `/` characters as they are used to create a folder structure.
 */
const formatKey = key => {
  return key
    .split('/')
    .map(encodeURIComponent)
    .map(key => key.replace(/\(/g, '%28').replace(/\)/g, '%29')) // encodeURIComponent does not encode `(` and `)`, but we want to encode them
    .join('/');
};

const main = async options => {
  const concurrency = parseInt(options['concurrency']) || 3;
  const allObjects = await getNonTrashedFilesFromS3(Boolean(options['ignoreCache']));

  // Get a report for all S3 files presence in the database
  const results: [{ key: string; uploadedFileId: number; deletedAt: Date }] = await sequelize.query(
    `
      SELECT
        "key",
        "uf"."id" AS "uploadedFileId",
        "uf"."deletedAt" AS "deletedAt"
      FROM UNNEST(ARRAY[:keys]) "key"
      LEFT JOIN "UploadedFiles" "uf"
        ON "uf"."url" = 'https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com/' || "key"
        OR "uf"."url" = 'https://${config.aws.s3.bucket}.s3-us-west-1.amazonaws.com/' || "key"
    `,
    {
      type: sequelize.QueryTypes.SELECT,
      replacements: { keys: allObjects.map(o => formatKey(o.Key)) },
    },
  );

  // Log report
  const filesDeletedInDbButNotInS3 = results.filter(r => r.uploadedFileId && r.deletedAt);
  const filesNotInLocalDb = results.filter(r => !r.uploadedFileId);
  logger.info(`Found ${filesDeletedInDbButNotInS3.length} files trashed in database but not in S3`);
  logger.info(`Found ${filesNotInLocalDb.length} files in S3 but not in database`);

  // Actually trash files
  if (!DRY_RUN) {
    const queue = new PQueue({ concurrency });
    const s3UrlFromKey = key => `https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com/${key}`; // We don't care about the exact URL format here, just need to make sure it includes the bucket and the key
    filesDeletedInDbButNotInS3.forEach(file => queue.add(() => trashFileFromS3(s3UrlFromKey(file.key), 'deleted')));
    filesNotInLocalDb.forEach(file => queue.add(() => trashFileFromS3(s3UrlFromKey(file.key), 'neverRecorded')));

    // Show progress
    let curFile = 0;
    const totalFiles = filesDeletedInDbButNotInS3.length + filesNotInLocalDb.length;
    const logProgress = () => {
      if (curFile++ % 100 === 0) {
        logger.info(`Trashed ${curFile}/${totalFiles} files (${((curFile / totalFiles) * 100).toFixed(2)}%)`);
      }
    };
    queue.on('active', logProgress);

    // Process the queue
    await queue.onIdle();
  } else {
    logger.info('DRY_RUN is enabled, skipping actual trashing of files');
  }

  logger.info('Done');
};

const program = new Command()
  .option('--concurrency <number>', 'Number of concurrent requests to S3', '3')
  .option('--ignoreCache', 'Ignore local cache and fetch all files from S3')
  .parse(process.argv);

main(program.opts())
  .then(() => {
    process.exit(0);
  })
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
