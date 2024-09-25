import '../server/env';

import { Command } from 'commander';
import { uniq } from 'lodash';

import { getElasticSearchClient } from '../server/lib/elastic-search/client';
import { ElasticSearchIndexName } from '../server/lib/elastic-search/constants';
import { elasticSearchGlobalSearch } from '../server/lib/elastic-search/search';
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

const parseIndexesFromInput = (
  indexes,
  defaultValue = Object.values(ElasticSearchIndexName),
): ElasticSearchIndexName[] => {
  if (!indexes?.length) {
    return defaultValue;
  }

  const allIndexes = Object.values(ElasticSearchIndexName);
  const uniqIndexes = uniq(indexes) as ElasticSearchIndexName[];
  uniqIndexes.forEach(index => {
    if (!allIndexes.includes(index as ElasticSearchIndexName)) {
      throw new Error(`Invalid index: ${index}`);
    }
  });

  return uniqIndexes;
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
      const indexes = parseIndexesFromInput(indexesInput);
      const modelsLabels = indexes.length === allIndexes.length ? 'all indices' : indexes.join(', ');
      logger.info(`Syncing ${modelsLabels} from ${parsedDate.toISOString()}`);
      for (const indexName of indexes) {
        await syncElasticSearchIndex(indexName as ElasticSearchIndexName, { fromDate: parsedDate, log: true });
      }

      logger.info('Sync completed!');
    }
  });

program
  .command('stats')
  .description('Show information about the ElasticSearch indices')
  .argument('[indexes...]', 'Only show information about specific indexes')
  .action(async indexesInput => {
    checkElasticSearchAvailable();
    const indexes = parseIndexesFromInput(indexesInput);
    const client = getElasticSearchClient();
    const result = await client.indices.stats({ index: indexes.join(',') });

    let nbDocs = 0;
    let totalSize = 0;
    const formatSize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    Object.entries(result.indices).forEach(([index, values]) => {
      console.log(`- Index: ${index}`);
      console.log(`  - Docs: ${values.primaries.docs.count}`);
      console.log(`  - Size: ${formatSize(values.primaries.store.size_in_bytes)}`);

      nbDocs += values.primaries.docs.count;
      totalSize += values.primaries.store.size_in_bytes;
    });

    console.log('====== Total ======');
    console.log(`- Docs: ${nbDocs}`);
    console.log(`- Size: ${formatSize(totalSize)}`);
  });

program
  .command('query')
  .description('Query ElasticSearch')
  .argument('<query>', 'Query string')
  .argument('[indexes...]', 'Only query specific indexes')
  .option('--limit <limit>', 'Limit the number of results', '10')
  .action(async (query, indexesInput, options) => {
    checkElasticSearchAvailable();
    const indexes = parseIndexesFromInput(indexesInput);
    const result = await elasticSearchGlobalSearch(indexes, query, parseInt(options.limit, 3), [], null, null);
    console.log('Result', JSON.stringify(result, null, 2));
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
