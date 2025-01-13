/**
 * This script assumes that all files still being used have been recorded to the `UploadedFile` table (using `scripts/uploaded-files/record-existing-files.ts`).
 * It will move all files that are in S3 but not in the database to a trash folder by prepending `trash/` to the key.
 */

import '../../server/env';

import fs from 'fs';

import { Command } from 'commander';
import config from 'config';
import moment from 'moment';
import PQueue from 'p-queue';

import { listFilesInS3, S3_TRASH_PREFIX, trashFileFromS3 } from '../../server/lib/awsS3';
import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const LOCAL_CACHE_FILE = 'output/s3-files.json';
const IGNORED_FILES = [
  'robots.txt',
  // Old platform settlements
  'Open Collective Foundation 501(c)(3)-April-2021.gdlV44.csv',
  'Open Collective Foundation 501(c)(3)-August-2021.607fe537.csv',
  'Open Collective Foundation 501(c)(3)-December-2020.vL0CPB.csv',
  'Open Collective Foundation 501(c)(3)-February-2021.bpFNIv.csv',
  'Open Collective Foundation 501(c)(3)-January-2021.lKHZJu.csv',
  'Open Collective Foundation 501(c)(3)-July-2021.f3828857.csv',
  'Open Collective Foundation 501(c)(3)-June-2021.45564876.csv',
  'Open Collective Foundation 501(c)(3)-March-2021.XgOxEN.csv',
  'Open Collective Foundation 501(c)(3)-May-2021.itPy5f.csv',
  'Open Collective Foundation 501(c)(3)-November-2020.QOsUFi.csv',
  'Open Source Collective 501(c)(6)-December-2020.cHHPDT.csv',
  'Open Source Collective 501(c)(6)-November-2020.7FGan5.csv',
];

const getNonTrashedFilesFromS3 = async (ignoreCache: boolean) => {
  let objects: Awaited<ReturnType<typeof listFilesInS3>> = [];
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
  return key.split('/').map(encodeURIComponent).join('/');
};

const main = async options => {
  if (!options.ignoreDeprecation) {
    logger.warn(
      'This script currently has issues with parentheses we ran in subfolders. It seems that the way S3 encoded them changed through time. Please be extra careful when running without "--onlyRootFolder". Use `ignoreDeprecation` to ignore this warning.',
    );
    process.exit(1);
  }

  const concurrency = parseInt(options['concurrency']) || 3;
  const allObjects = await getNonTrashedFilesFromS3(Boolean(options['ignoreCache']));
  const includeSoftDeleted = Boolean(options['includeSoftDeleted']);
  const onlyRootFolder = Boolean(options['onlyRootFolder']);
  const filteredObjects = onlyRootFolder ? allObjects.filter(o => !o.Key.includes('/')) : allObjects;

  // Get a report for all S3 files presence in the database
  const results: [{ key: string; uploadedFileId: number; deletedAt: Date }] = await sequelize.query(
    `
      SELECT
        "key",
        "uf"."id" AS "uploadedFileId",
        "uf"."deletedAt" AS "deletedAt",
        "uf".url AS url
      FROM UNNEST(ARRAY[:keys]) "key"
      LEFT JOIN "UploadedFiles" "uf"
        ON "uf"."url" = 'https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com/' || "key"
    `,
    {
      type: sequelize.QueryTypes.SELECT,
      replacements: { keys: filteredObjects.map(o => formatKey(o.Key)) },
    },
  );

  // Log report
  const filesDeletedInDbButNotInS3 = !includeSoftDeleted ? [] : results.filter(r => r.uploadedFileId && r.deletedAt);
  const filesNotInLocalDb = results.filter(r => !r.uploadedFileId);
  logger.info(`Found ${filesDeletedInDbButNotInS3.length} files trashed in database but not in S3`);
  logger.info(`Found ${filesNotInLocalDb.length} files in S3 but not in database`);
  logger.info('Saving the list of files to delete to `output/files-to-delete.json`');
  fs.writeFileSync(
    'output/files-to-delete.json',
    JSON.stringify({ filesDeletedInDbButNotInS3, filesNotInLocalDb }, null, 2),
  );

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
  .option('--includeSoftDeleted', 'Include files that have been soft deleted in the database')
  .option('--onlyRootFolder', 'Only consider files in the root folder (no subfolders)')
  .option('--ignoreDeprecation', 'Ignore the deprecation block')
  .parse(process.argv);

main(program.opts())
  .then(() => {
    process.exit(0);
  })
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
