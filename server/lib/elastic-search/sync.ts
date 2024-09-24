/**
 * Functions to sync data between the database and elastic search
 */

import { Op } from '../../models';
import logger from '../logger';

import { ElasticSearchCollectivesAdapter } from './adapters/ElasticSearchCollectivesAdapter';
import { ElasticSearchCommentsAdapter } from './adapters/ElasticSearchCommentsAdapter';
import { ElasticSearchExpensesAdapter } from './adapters/ElasticSearchExpensesAdapter';
import { ElasticSearchHostApplicationsAdapter } from './adapters/ElasticSearchHostApplicationsAdapter';
import { ElasticSearchModelAdapter } from './adapters/ElasticSearchModelAdapter';
import { ElasticSearchOrdersAdapter } from './adapters/ElasticSearchOrdersAdapter';
import { ElasticSearchTiersAdapter } from './adapters/ElasticSearchTiersAdapter';
import { ElasticSearchTransactionsAdapter } from './adapters/ElasticSearchTransactionsAdapter';
import { ElasticSearchUpdatesAdapter } from './adapters/ElasticSearchUpdatesAdapter';
import { getElasticSearchClient } from './client';
import { ElasticSearchIndexName } from './constants';

const Adapters: Record<ElasticSearchIndexName, ElasticSearchModelAdapter> = {
  [ElasticSearchIndexName.COLLECTIVES]: new ElasticSearchCollectivesAdapter(),
  [ElasticSearchIndexName.COMMENTS]: new ElasticSearchCommentsAdapter(),
  [ElasticSearchIndexName.EXPENSES]: new ElasticSearchExpensesAdapter(),
  [ElasticSearchIndexName.HOST_APPLICATIONS]: new ElasticSearchHostApplicationsAdapter(),
  [ElasticSearchIndexName.ORDERS]: new ElasticSearchOrdersAdapter(),
  [ElasticSearchIndexName.TIERS]: new ElasticSearchTiersAdapter(),
  [ElasticSearchIndexName.TRANSACTIONS]: new ElasticSearchTransactionsAdapter(),
  [ElasticSearchIndexName.UPDATES]: new ElasticSearchUpdatesAdapter(),
} as const;

export async function createElasticSearchIndices() {
  const client = getElasticSearchClient({ throwIfUnavailable: true });
  for (const adapter of Object.values(Adapters)) {
    await client.indices.create({
      index: adapter.index,
      body: { mappings: adapter['mappings'], settings: adapter['settings'] },
    });
  }
}

async function removeDeletedEntries(indexName: ElasticSearchIndexName, fromDate: Date) {
  const client = getElasticSearchClient({ throwIfUnavailable: true });
  const adapter = Adapters[indexName];
  const pageSize = 20000; // We're only fetching the id, so we can fetch more entries at once
  let offset = 0;
  let deletedEntries = [];
  do {
    deletedEntries = await adapter.model.findAll({
      attributes: ['id'],
      where: { deletedAt: { [Op.gt]: fromDate } },
      raw: true,
      limit: pageSize,
      offset,
    });

    if (deletedEntries.length === 0) {
      return;
    }
    await client.bulk({
      index: indexName,
      body: deletedEntries.flatMap(entry => [{ delete: { _id: entry.id } }]),
    });
    offset += pageSize;
  } while (deletedEntries.length === pageSize);
}

export async function syncElasticSearchIndex(
  indexName: ElasticSearchIndexName,
  options: { fromDate?: Date; log?: boolean } = {},
) {
  const { fromDate } = options;

  if (options.log) {
    logger.info(`Syncing index ${indexName}...`);
  }

  // If there's a fromDate, it means we are doing a simple sync (not a full resync) and therefore need to look at deleted entries
  if (fromDate) {
    await removeDeletedEntries(indexName, fromDate);
  }

  // Sync new/edited entries
  const client = getElasticSearchClient({ throwIfUnavailable: true });
  const adapter = Adapters[indexName];
  const limit = 5000;
  let modelEntries = [];
  let firstReturnedId = undefined;
  let offset = 0;
  do {
    modelEntries = await adapter.findEntriesToIndex(offset, limit, { fromDate, firstReturnedId });
    if (modelEntries.length === 0) {
      return;
    } else if (!firstReturnedId) {
      firstReturnedId = modelEntries[0].id;
    }

    // Send data to ElasticSearch
    await client.bulk({
      index: indexName,
      body: modelEntries.flatMap(entry => [{ index: { _id: entry.id } }, adapter.mapModelInstanceToDocument(entry)]),
    });

    offset += limit;
  } while (modelEntries.length === limit);
}

/**
 * Sync all the rows of a model with elastic search.
 *
 * @param options.fromDate Only sync rows updated/deleted after this date
 */
export const syncElasticSearchIndexes = async (options: { fromDate?: Date; log?: boolean } = {}) => {
  for (const indexName of Object.keys(Adapters)) {
    await syncElasticSearchIndex(indexName as ElasticSearchIndexName, options);
  }
};

/**
 * Deletes all indexes currently on Elastic search, resulting in a clean new state.
 * Use carefully!
 */
export const deleteElasticSearchIndices = async () => {
  const client = getElasticSearchClient({ throwIfUnavailable: true });
  const indices = await client.cat.indices({ format: 'json' });
  for (const index of indices) {
    await client.indices.delete({ index: index.index });
  }
};
