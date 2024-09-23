import '../server/env';

import { Command } from 'commander';
import { uniq } from 'lodash';

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

// Re-index command
program
  .command('reindex')
  .description('Reindex all models')
  .action(async () => {
    if (
      confirm(
        'WARNING: This will delete all existing data in the indices and recreated everything, which is expensive. You should make sure that background synchronization job is disabled. Are you sure you want to continue?',
      )
    ) {
      await deleteElasticSearchIndices();
      await createElasticSearchIndices();
      await syncElasticSearchIndexes();
    }
  });

// Sync command
program
  .command('sync')
  .description('Sync models')
  .argument('<fromDate>', 'Only sync rows updated/deleted after this date')
  .argument('[indexes...]', 'Only sync specific indexes')
  .action(async (fromDate, indexesStr) => {
    const parsedDate = new Date(fromDate);
    if (isNaN(parsedDate.getTime())) {
      throw new Error('Invalid date');
    } else {
      const allIndexes = Object.values(ElasticSearchIndexName);
      const indexes = indexesStr ? uniq(indexesStr.split(',')) : allIndexes;
      indexes.forEach(index => {
        if (!allIndexes.includes(index as ElasticSearchIndexName)) {
          throw new Error(`Invalid index: ${index}`);
        }
      });

      const modelsLabels = indexes.length === allIndexes.length ? 'all models' : indexes.join(', ');
      logger.info(`Syncing ${modelsLabels} from ${parsedDate.toISOString()}`);
      for (const indexName of indexes) {
        await syncElasticSearchIndex(indexName as ElasticSearchIndexName, { fromDate: parsedDate });
      }
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
