import '../server/env';

import { Command } from 'commander';
import { partition, uniq } from 'lodash';

import { getElasticSearchClient } from '../server/lib/elastic-search/client';
import { ElasticSearchIndexName } from '../server/lib/elastic-search/constants';
import { elasticSearchGlobalSearch } from '../server/lib/elastic-search/search';
import {
  createElasticSearchIndex,
  deleteElasticSearchIndex,
  getAvailableElasticSearchIndexes,
  syncElasticSearchIndex,
} from '../server/lib/elastic-search/sync';
import logger from '../server/lib/logger';
import models from '../server/models';

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

// Command to drop everything
program
  .command('drop')
  .description('Drops indices')
  .argument('[indexes...]', 'Only drop specific indexes')
  .action(async indexesInput => {
    checkElasticSearchAvailable();
    const indexes = parseIndexesFromInput(indexesInput);
    if (
      await confirm(
        'WARNING: This will delete all existing data in the indices, which is expensive. You should make sure that background synchronization job is disabled. Are you sure you want to continue?',
      )
    ) {
      logger.info('Dropping all indices...');
      for (const indexName of indexes) {
        logger.info(`Dropping index ${indexName}`);
        await deleteElasticSearchIndex(indexName);
      }
      logger.info('Drop completed!');
    }
  });

// Command to create indices
program
  .command('create')
  .description('Creates indices')
  .argument('[indexes...]', 'Create indices (must not exist)')
  .action(async indexesInput => {
    checkElasticSearchAvailable();
    const indexes = parseIndexesFromInput(indexesInput);
    logger.info('Creating all indices...');
    for (const indexName of indexes) {
      logger.info(`Creating index ${indexName}`);
      await createElasticSearchIndex(indexName);
    }
    logger.info('Create completed!');
  });

// Re-index command
program
  .command('reset')
  .description('Drops all indices, re-create and re-index everything')
  .argument('[indexes...]', 'Only sync specific indexes')
  .action(async indexesInput => {
    checkElasticSearchAvailable();
    const indexes = parseIndexesFromInput(indexesInput);
    if (
      await confirm(
        'WARNING: This will delete all existing data in the indices and recreated everything, which is expensive. You should make sure that background synchronization job is disabled. Are you sure you want to continue?',
      )
    ) {
      logger.info('Syncing all models...');
      for (const indexName of indexes) {
        logger.info(`Dropping index ${indexName}`);
        await deleteElasticSearchIndex(indexName, { throwIfMissing: false });
        logger.info(`Re-creating index ${indexName}`);
        await createElasticSearchIndex(indexName);
        await syncElasticSearchIndex(indexName, { log: true });
      }
      logger.info('Re-index completed!');
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
    const availableIndexes = await getAvailableElasticSearchIndexes();
    const [availableIndexesToQuery, unknownIndexes] = partition(indexes, index => availableIndexes.includes(index));
    if (unknownIndexes.length) {
      logger.warn(`Unknown indexes: ${unknownIndexes.join(', ')}`);
    }

    const result = await client.indices.stats({ index: availableIndexesToQuery.join(',') });
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
  .option('--limit <limit>', 'Limit the number of results', '3')
  .option('--account <accountSlug>', 'Account slug to filter results')
  .option('--host <hostSlug>', 'Host slug to filter results')
  .option('--as <userSlug>', 'User making the request')
  .action(async (query, indexesInput, options) => {
    checkElasticSearchAvailable();
    const indexes = parseIndexesFromInput(indexesInput);
    const limit = parseInt(options.limit, 10);
    const account = options.account && (await models.Collective.findBySlug(options.account));
    const host = options.host && (await models.Collective.findBySlug(options.host));
    let adminOfAccountIds = [];
    if (options.as) {
      const asCollective = await models.Collective.findBySlug(options.as);
      const asUser = asCollective && (await models.User.findOne({ where: { CollectiveId: asCollective.id } }));
      if (!asUser) {
        throw new Error(`User not found: ${options.as}`);
      }

      await asUser.populateRoles();
      adminOfAccountIds = Object.keys(asUser.rolesByCollectiveId).filter(id => asUser.isAdmin(id));
    }

    const result = await elasticSearchGlobalSearch(indexes, query, limit, adminOfAccountIds, account, host);
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
