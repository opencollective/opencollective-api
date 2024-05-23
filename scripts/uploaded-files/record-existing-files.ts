/**
 * This script will record all existing files from fields like "Expense.item.url", "Update.html", etc.
 * to the "UploadedFile" table.
 */

import '../../server/env';

import { Command } from 'commander';
import { pickBy, toPath } from 'lodash';
import PQueue from 'p-queue';

import { FileKind } from '../../server/constants/file-kind';
import { getFileInfoFromS3 } from '../../server/lib/awsS3';
import logger from '../../server/lib/logger';
import { FileFieldsDefinition } from '../../server/lib/uploaded-files';
import { parseToBoolean } from '../../server/lib/utils';
import models, { sequelize } from '../../server/models';
import UploadedFile, { SUPPORTED_FILE_TYPES } from '../../server/models/UploadedFile';

const DRY_RUN = process.env.DRY_RUN ? parseToBoolean(process.env.DRY_RUN) : true;

const recordFile = async (
  kind: FileKind,
  url: string,
  { fileName = null, CreatedByUserId = null, deletedAt = null } = {},
  progressStr = '',
): Promise<UploadedFile | void> => {
  // Get file info from S3
  let fileInfo;
  try {
    fileInfo = await getFileInfoFromS3(url);
  } catch (e) {
    if (e.code === 'NotFound') {
      logger.warn(`File ${url} (${kind}) not found on S3, consider deleting it`);
      return;
    } else {
      throw e;
    }
  }

  const attributes = {
    url,
    kind,
    CreatedByUserId,
    createdAt: fileInfo.LastModified,
    deletedAt,
    updatedAt: new Date(), // Record current date
    fileName: fileName,
    fileSize: fileInfo.ContentLength,
    fileType: fileInfo.ContentType as (typeof SUPPORTED_FILE_TYPES)[number], // This will not be necessarily a supported type, but we still want to record everything
    data: { recordedFrom: 'scripts/uploaded-files/record-existing-files.ts' },
  };

  const prettySize = `${Math.round(fileInfo.ContentLength / 1024)} KB`;
  const message = `${kind} ${progressStr} recorded for ${url} as ${fileInfo.ContentType} (${prettySize})`;
  if (!DRY_RUN) {
    const uploadedFile = await models.UploadedFile.create(attributes, { validate: false }); // Skipping the validations to allow any `fileType`
    logger.info(`${message} with id #${uploadedFile.id}`);
  } else {
    logger.info(`[DRY RUN] ${message}`);
  }
};

/**
 * /!\ `fieldName` is not escaped, make sure it's not user input.
 *
 * Formats the field name to be used in SQL queries, handling nested JSON fields.
 * Examples:
 * - "url" will be converted to "url"
 * - "Collective.settings.customEmailMessage" will be converted to "settings"->>'customEmailMessage'
 * - "Collective.settings.nested.message" will be converted to "settings"->'nested'->>'message'
 */
const prepareFieldNameForSQL = (fieldName: string): string => {
  const [column, ...path] = toPath(fieldName);
  return !path.length ? `"${column}"` : `"${column}"#>>'{${path.join(',')}}'`;
};

const main = async options => {
  const concurrency = parseInt(options['concurrency']) || 3;

  // Migrate simple fields
  if (!options['onlyLongText']) {
    const simpleFields = pickBy(FileFieldsDefinition, value => value.fieldType === 'url');

    // Iterate on fields
    for (const kind in simpleFields) {
      const { model, field, UserIdField } = simpleFields[kind];
      logger.info(`Migrating ${model['tableName']}.${field}...`);
      const hasDeletedAt = Boolean(model['options']['paranoid']);
      const urlField = prepareFieldNameForSQL(field);
      const records = await sequelize.query(
        ` SELECT
          MIN(id) AS id,
          ${urlField} as "url",
          ${UserIdField ? `MIN("${UserIdField}")` : 'NULL'} AS "UserId",
          ${hasDeletedAt ? 'MIN("deletedAt")' : 'NULL'} AS "deletedAt"
        FROM "${model['tableName']}" model
        WHERE ${urlField} IS NOT NULL
        AND ${urlField} ILIKE 'https://%.s3%.amazonaws.com/%'
        AND NOT EXISTS (
          SELECT 1
          FROM "UploadedFiles" uploaded_file
          WHERE uploaded_file."url" = model.${urlField}
        )
        GROUP BY ${urlField} -- It's an anti-pattern, but in practice we have multiple records with the same URL (e.g. there are 3 collectives with the avatar https://opencollective-production.s3.us-west-1.amazonaws.com/1b4efc60-897d-11ea-a8b1-f7f3041d4994.jpg)
      `,
        {
          type: sequelize.QueryTypes.SELECT,
        },
      );

      // Process files concurrently, but limit the number of concurrent requests to S3
      logger.info(`Found ${records.length} records for ${model['tableName']} to migrate...`);
      const queue = new PQueue({ concurrency });
      records.forEach((record, recordIdx) =>
        queue.add(() => {
          const fileAttributes = { CreatedByUserId: record['UserId'], deletedAt: record['deletedAt'] };
          return recordFile(kind as FileKind, record['url'], fileAttributes, `(${recordIdx + 1}/${records.length})`);
        }),
      );

      await queue.onIdle();
    }
  }

  // Migrate long text fields
  if (!options['onlySimple']) {
    const richTextFields = pickBy(FileFieldsDefinition, value => value.fieldType === 'richText');
    for (const kind in richTextFields) {
      const { model, field, UserIdField } = richTextFields[kind];
      logger.info(`Migrating ${model['tableName']}.${field}...`);
      const hasDeletedAt = Boolean(model['options']['paranoid']);
      const textField = prepareFieldNameForSQL(field);
      const records = await sequelize.query(
        ` WITH all_images AS (
          SELECT
            (regexp_matches(${textField}, 'src="(https://opencollective-production\.s3\.us-west-1\.amazonaws\.com/[^"]+)', 'g'))[1] as "url",
            ${UserIdField ? `"${UserIdField}"` : 'NULL'} AS "UserId",
            ${hasDeletedAt ? '"deletedAt"' : 'NULL'} AS "deletedAt"
          FROM "${model['tableName']}"
          WHERE ${textField} IS NOT NULL
        ) SELECT "url", MIN("UserId"), ${hasDeletedAt ? 'MIN("deletedAt")' : 'NULL'} AS "deletedAt"
        FROM all_images
        WHERE NOT EXISTS (
          SELECT 1
          FROM "UploadedFiles" uf
          WHERE uf."url" = all_images."url"
        )
        GROUP BY "url"
      `,
        {
          type: sequelize.QueryTypes.SELECT,
        },
      );

      // Process files concurrently, but limit the number of concurrent requests to S3
      logger.info(`Found ${records.length} records for ${model['tableName']} to migrate...`);
      const queue = new PQueue({ concurrency });
      records.forEach((record, recordIdx) =>
        queue.add(() => {
          const fileAttributes = { CreatedByUserId: record['UserId'], deletedAt: record['deletedAt'] };
          return recordFile(kind as FileKind, record['url'], fileAttributes, `(${recordIdx + 1}/${records.length})`);
        }),
      );

      await queue.onIdle();
    }
  }
};

const program = new Command()
  .option('--onlySimple', 'Only migrate simple fields')
  .option('--onlyLongText', 'Only migrate long text fields')
  .option('--concurrency <number>', 'Number of concurrent requests to S3', '3')
  .parse(process.argv);

main(program.opts())
  .then(() => {
    process.exit(0);
  })
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
