/**
 * Converts independent collectives to organizations.
 * This script performs the same conversion as the migration but uses Sequelize
 * to ensure proper model handling and hooks.
 */

import '../../server/env';

import { Command } from 'commander';

import { activities } from '../../server/constants';
import { CollectiveType } from '../../server/constants/collectives';
import logger from '../../server/lib/logger';
import models, { Collective, sequelize } from '../../server/models';

const DRY_RUN = process.env.DRY_RUN !== 'false';

const program = new Command();

program.option('--limit <number>', 'Limit the number of accounts to process', parseInt);
program.option('--offset <number>', 'Offset for pagination', parseInt);
program.option('--slug <string>', 'The slug of the collective to convert');

const main = async (options: { isDryRun: boolean; limit?: number; offset?: number; slug?: string }) => {
  const { count, rows: collectives } = await Collective.findAndCountAll({
    order: [['id', 'ASC']],
    limit: options.limit,
    offset: options.offset,
    where: {
      type: CollectiveType.COLLECTIVE,
      HostCollectiveId: sequelize.literal('"HostCollectiveId" = "id"'),
      ...(options.slug ? { slug: options.slug } : {}),
    },
  });

  if (collectives.length === 0) {
    logger.info('No independent collectives to convert');
    return;
  }

  logger.info(`Found ${count} independent collectives. Processing ${collectives.length}...`);

  let converted = 0;
  let skipped = 0;
  for (const collective of collectives) {
    try {
      logger.info(`Converting ${collective.slug} (id: ${collective.id}) from ${collective.type} to ORGANIZATION...`);

      if (!options.isDryRun) {
        await collective.update({
          type: CollectiveType.ORGANIZATION,
          data: {
            ...collective.data,
            canHostAccount: false,
          },
        });
        await collective.activateMoneyManagement(null, { force: true, silent: true });
        await models.Activity.create({
          type: activities.COLLECTIVE_CONVERTED_TO_ORGANIZATION,
          UserId: null,
          UserTokenId: null,
          CollectiveId: collective.id,
          FromCollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
          data: {
            collective: collective.minimal,
          },
        });

        converted++;
      } else {
        logger.info(`[DRY RUN] Would convert ${collective.slug} (id: ${collective.id})`);
        converted++;
      }
    } catch (error) {
      logger.error(`Error converting ${collective.slug} (id: ${collective.id}): ${error.message}`);
      skipped++;
    }
  }

  if (!options.isDryRun) {
    logger.info(`Conversion completed successfully! Converted: ${converted}, Skipped: ${skipped}`);
  }
};

program.action(async options => {
  logger.info('Starting conversion...');
  logger.info(`DRY_RUN: ${DRY_RUN}`);
  await main({ ...options, isDryRun: DRY_RUN });
});

if (!module.parent) {
  program
    .parseAsync()
    .then(() => {
      process.exit(0);
    })
    .catch(e => {
      logger.error(e.toString());
      process.exit(1);
    });
}
