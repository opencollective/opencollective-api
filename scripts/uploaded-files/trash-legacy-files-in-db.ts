/**
 * This script will mark all files from fields like "ExpenseItem.url", "Update.html", etc. as deleted
 * when their corresponding record is marked as deleted.
 */

import '../../server/env';

import { Command } from 'commander';
import { toPath } from 'lodash';
import moment from 'moment';

import logger from '../../server/lib/logger';
import { FileFieldsDefinition } from '../../server/lib/uploaded-files';
import { parseToBoolean } from '../../server/lib/utils';
import { sequelize } from '../../server/models';

const DRY_RUN = process.env.DRY_RUN ? parseToBoolean(process.env.DRY_RUN) : true;

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
  const olderThanDays = parseInt(options.olderThan);
  const olderThanDate = moment().subtract(olderThanDays, 'days');

  for (const [kind, definition] of Object.entries(FileFieldsDefinition)) {
    logger.info(`Processing ${kind}...`);
    const cleanField = prepareFieldNameForSQL(definition.field);
    const hasSoftDelete = Boolean(definition.model['options']['paranoid']);
    const timeLabel = `Performance for analyzing ${kind}`;
    console.time(timeLabel);
    const result = await sequelize.query(
      `
        ${DRY_RUN ? 'BEGIN;' : ''}
        -- Pre-extract all links from the field as it makes the query way faster for rich text
        WITH all_links_from_content AS (
          SELECT
            ${
              definition.fieldType === 'url'
                ? `${cleanField}`
                : `(regexp_matches(${cleanField}, 'src="(https://opencollective-production\.s3\.us-west-1\.amazonaws\.com/[^"]+)', 'g'))[1]`
            } AS "url"
          FROM "${definition.model['tableName']}"
          WHERE ${cleanField} IS NOT NULL
          ${hasSoftDelete ? `AND ("deletedAt" IS NULL OR "deletedAt" < :olderThanDate)` : ''}
        ), files_to_delete AS (
          SELECT id
          FROM "UploadedFiles" uf
          WHERE uf."deletedAt" IS NULL
          AND uf."createdAt" < :olderThanDate -- No need to look at files newer than the oldest file to delete
          AND "kind" = :kind
          AND NOT EXISTS (
            SELECT 1 FROM all_links_from_content
            WHERE uf."url" = all_links_from_content."url"
          )
        ) UPDATE "UploadedFiles" uf
        SET
          "deletedAt" = NOW(),
          "data" = JSONB_SET(COALESCE("data", '{}'::jsonb), '{deletedByTrashLegacyFilesInDbAt}', to_jsonb(NOW()))
        FROM files_to_delete
        WHERE uf."id" = files_to_delete."id"
        RETURNING uf.id, uf.url;
        ${DRY_RUN ? 'ROLLBACK;' : ''}
      `,
      {
        type: sequelize.QueryTypes.SELECT,
        replacements: { kind, olderThanDate: olderThanDate.toDate() },
      },
    );
    console.timeEnd(timeLabel);
    logger.info(`${DRY_RUN ? '[DRY RUN]' : ''} Deleted ${result.length} files in ${kind} ${result.map(r => r.id)}`);
  }
};

const program = new Command()
  .option('--olderThan', 'Only delete files removed since more than X days', '60')
  .parse(process.argv);

main(program.opts())
  .then(() => {
    process.exit(0);
  })
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
