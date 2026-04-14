/**
 * See https://github.com/opencollective/opencollective/issues/7677
 * Files uploaded before https://github.com/opencollective/opencollective-api/pull/8443 were not placed
 * in subdirectories. This script intends to move them to the correct location.
 */

import '../../server/env';

import { Command } from 'commander';
import config from 'config';
import { kebabCase } from 'lodash';
import { QueryTypes } from 'sequelize';
import { v4 as uuid } from 'uuid';

import { copyFileInS3, getS3URL, parseS3Url } from '../../server/lib/awsS3';
import logger from '../../server/lib/logger';
import models, { sequelize } from '../../server/models';

const program = new Command();

program.option('--run', 'Run the script. If not set, the script will only show the files that will be moved.');
program.option('--limit <number>', 'Limit the number of files to move.', parseInt);
program.option('--id <number>', 'Move a specific file by id.', parseInt);

program.action(async options => {
  const files = (await sequelize.query(
    `
    SELECT "id", "url", "kind"
    FROM "UploadedFiles"
    WHERE "url" ILIKE 'https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com/%'
    AND "url" NOT ILIKE 'https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com/%/%'
    AND kind IN ('EXPENSE_ATTACHED_FILE', 'EXPENSE_ITEM')
    ${options.id ? `AND "id" = :id` : ''}
    ORDER BY "id"
    ${options.limit ? `LIMIT :limit` : ''}
  `,
    {
      type: QueryTypes.SELECT,
      replacements: {
        limit: options.limit,
        id: options.id,
      },
    },
  )) as { id: number; url: string; kind: 'EXPENSE_ATTACHED_FILE' | 'EXPENSE_ITEM' }[];

  if (!files.length) {
    logger.info('No files to move.');
    return;
  }

  logger.info(`Found ${files.length} files to move.`);
  for (const file of files) {
    const { bucket, key } = parseS3Url(file.url);
    const newKey = `${kebabCase(file.kind)}/${uuid()}/${key}`;
    const newUrl = getS3URL(bucket, newKey);

    if (!options.run) {
      logger.info(`Would copy file ${file.url} to ${getS3URL(bucket, newKey)}`);
    } else {
      await copyFileInS3(file.url, newKey);
      logger.info(`File ${file.url} copied to ${newUrl}. Updating models...`);
      await Promise.all([
        models.UploadedFile.update({ url: newUrl }, { where: { url: file.url } }),
        models.ExpenseItem.update({ url: newUrl }, { where: { url: file.url } }),
        models.ExpenseAttachedFile.update({ url: newUrl }, { where: { url: file.url } }),
      ]);
    }
  }
});

if (!module.parent) {
  program
    .parseAsync()
    .then(() => {
      process.exit(0);
    })
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
