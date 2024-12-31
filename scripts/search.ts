import '../server/env';

import { Command } from 'commander';
import config from 'config';
import { partition, uniq } from 'lodash';

import { getElasticSearchClient } from '../server/lib/elastic-search/client';
import { formatIndexNameForElasticSearch } from '../server/lib/elastic-search/common';
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
      const realIndexName = formatIndexNameForElasticSearch(indexName);
      logger.info(`Creating index ${indexName}${realIndexName !== indexName ? ` (${realIndexName})` : ''}`);
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
        const realIndexName = formatIndexNameForElasticSearch(indexName);
        logger.info(`Dropping index ${indexName}${realIndexName !== indexName ? ` (${realIndexName})` : ''}`);
        await deleteElasticSearchIndex(indexName, { throwIfMissing: false });
        logger.info(`Re-creating index ${indexName}${realIndexName !== indexName ? ` (${realIndexName})` : ''}`);
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

    let parsedDate;
    if (fromDate !== 'all') {
      parsedDate = new Date(fromDate);
      if (isNaN(parsedDate.getTime())) {
        throw new Error('Invalid date');
      }
    }

    const allIndexes = Object.values(ElasticSearchIndexName);
    const indexes = parseIndexesFromInput(indexesInput);
    const modelsLabels = indexes.length === allIndexes.length ? 'all indices' : indexes.join(', ');
    logger.info(`Syncing ${modelsLabels} from ${!parsedDate ? 'all time' : parsedDate.toISOString()}`);
    for (const indexName of indexes) {
      await syncElasticSearchIndex(indexName as ElasticSearchIndexName, { fromDate: parsedDate, log: true });
    }

    logger.info('Sync completed!');
  });

// Info command, to get the list of fields in the index
program
  .command('info')
  .description('Show information about the ElasticSearch indices')
  .argument('[indexes...]', 'Only show information about specific indexes')
  .action(async indexesInput => {
    checkElasticSearchAvailable();
    const indexes = parseIndexesFromInput(indexesInput);
    const availableIndexes = await getAvailableElasticSearchIndexes();
    const [availableIndexesToQuery, unknownIndexes] = partition(indexes, index => availableIndexes.includes(index));
    if (unknownIndexes.length) {
      logger.warn(`Unknown indexes: ${unknownIndexes.join(', ')}`);
    }

    const client = getElasticSearchClient();
    for (const index of availableIndexesToQuery) {
      const result = await client.indices.getMapping({ index });
      console.log(`Index: ${index}`);
      console.log(JSON.stringify(result, null, 2));
    }
  });

// Get the values for a single entry in an index
program
  .command('get')
  .description('Get a single entry from an index')
  .argument('<index>', 'Index name')
  .argument('<id>', 'Entry ID')
  .action(async (index, id) => {
    checkElasticSearchAvailable();
    const client = getElasticSearchClient();
    const result = await client.get({ index, id });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('stats')
  .description('Show information about the ElasticSearch indices')
  .argument('[indexes...]', 'Only show information about specific indexes')
  .option('--all', 'Show information about all indexes, even those not matching the prefix')
  .action(async (indexesInput, options) => {
    checkElasticSearchAvailable();
    const indexesFromArgs = parseIndexesFromInput(indexesInput, null);
    const client = getElasticSearchClient();
    let availableIndexes = await getAvailableElasticSearchIndexes();

    // Only get the indexes specified in args
    if (indexesFromArgs) {
      const partitionedIndexes = partition(indexesFromArgs, index => availableIndexes.includes(index));
      availableIndexes = partitionedIndexes[0];
      if (partitionedIndexes[1].length) {
        logger.warn(`Unknown indexes: ${partitionedIndexes[1].join(', ')}`);
      }
    }

    // Filter out indexes that don't match the prefix
    if (!options.all) {
      const prefix = config.elasticSearch.indexesPrefix;
      if (prefix) {
        availableIndexes = availableIndexes.filter(index => index.startsWith(prefix));
      } else {
        availableIndexes = availableIndexes.filter(index =>
          Object.values(ElasticSearchIndexName).includes(index as ElasticSearchIndexName),
        );
      }
    }

    const result = await client.indices.stats({ index: availableIndexes.join(',') });
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
    let user = null;
    if (options.as) {
      const asCollective = await models.Collective.findBySlug(options.as);
      user = asCollective && (await models.User.findOne({ where: { CollectiveId: asCollective.id } }));
      if (!user) {
        throw new Error(`User not found: ${options.as}`);
      }

      await user.populateRoles();
    }

    const indexInputs = indexes.map(index => ({ index }));
    const result = await elasticSearchGlobalSearch(query, indexInputs, { account, host, limit, user });
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
