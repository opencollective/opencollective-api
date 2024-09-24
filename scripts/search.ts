import '../server/env';

import { Command } from 'commander';
import { uniq } from 'lodash';

import { getElasticSearchClient } from '../server/lib/elastic-search/client';
import { ElasticSearchIndexName } from '../server/lib/elastic-search/constants';
import {
  createElasticSearchIndices,
  deleteElasticSearchIndices,
  syncElasticSearchIndex,
  syncElasticSearchIndexes,
} from '../server/lib/elastic-search/sync';
import logger from '../server/lib/logger';

import { confirm } from './common/helpers';

const program = new Command();

const checkElasticSearchAvailable = () => {
  if (!getElasticSearchClient()) {
    throw new Error('ElasticSearch is not configured');
  }
};

// Re-index command
program
  .command('reset')
  .description('Drops all indices, re-create and re-index everything')
  .action(async () => {
    checkElasticSearchAvailable();
    if (
      await confirm(
        'WARNING: This will delete all existing data in the indices and recreated everything, which is expensive. You should make sure that background synchronization job is disabled. Are you sure you want to continue?',
      )
    ) {
      logger.info('Deleting all indices...');
      await deleteElasticSearchIndices();
      logger.info('Creating new indices...');
      await createElasticSearchIndices();
      logger.info('Syncing all models...');
      await syncElasticSearchIndexes({ log: true });
      logger.info('Reindex completed!');
    }
  });

// Sync command
program
  .command('sync')
  .description('Sync models')
  .argument('<fromDate>', 'Only sync rows updated/deleted after this date')
  .argument('[indexes...]', 'Only sync specific indexes')
  .action(async (fromDate, indexesInput) => {
    checkElasticSearchAvailable();
    const parsedDate = new Date(fromDate);
    if (isNaN(parsedDate.getTime())) {
      throw new Error('Invalid date');
    } else {
      const allIndexes = Object.values(ElasticSearchIndexName);
      const indexes = !indexesInput.length ? allIndexes : uniq(indexesInput);
      indexes.forEach(index => {
        if (!allIndexes.includes(index as ElasticSearchIndexName)) {
          throw new Error(`Invalid index: ${index}`);
        }
      });

      const modelsLabels = indexes.length === allIndexes.length ? 'all indices' : indexes.join(', ');
      logger.info(`Syncing ${modelsLabels} from ${parsedDate.toISOString()}`);
      for (const indexName of indexes) {
        await syncElasticSearchIndex(indexName as ElasticSearchIndexName, { fromDate: parsedDate, log: true });
      }

      logger.info('Sync completed!');
    }
  });

// Entrypoint
if (!module.parent) {
  program
    .parseAsync(process.argv)
    .then(() => process.exit())
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
