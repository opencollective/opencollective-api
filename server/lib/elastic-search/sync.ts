/**
 * Functions to sync data between the database and elastic search
 */

import config from 'config';

import { Op } from '../../models';
import logger from '../logger';

import { ElasticSearchModelsAdapters } from './adapters';
import { getElasticSearchClient } from './client';
import { formatIndexNameForElasticSearch } from './common';
import { ElasticSearchIndexName } from './constants';

export async function createElasticSearchIndex(indexName: ElasticSearchIndexName) {
  const client = getElasticSearchClient({ throwIfUnavailable: true });
  const adapter = ElasticSearchModelsAdapters[indexName];
  if (!adapter) {
    throw new Error(`No ElasticSearch adapter found for index ${indexName}`);
  }

  return client.indices.create({
    index: formatIndexNameForElasticSearch(indexName),
    body: { mappings: adapter['mappings'], settings: adapter['settings'] },
  });
}

async function removeDeletedEntries(indexName: ElasticSearchIndexName, fromDate: Date, { log = false } = {}) {
  const client = getElasticSearchClient({ throwIfUnavailable: true });
  const adapter = ElasticSearchModelsAdapters[indexName];
  const pageSize = 20000; // We're only fetching the id, so we can fetch more entries at once
  let offset = 0;
  let deletedEntries = [];
  do {
    deletedEntries = await adapter.getModel().findAll({
      attributes: ['id'],
      where: { deletedAt: { [Op.gt]: fromDate } },
      raw: true,
      limit: pageSize,
      offset,
      paranoid: false,
    });

    if (deletedEntries.length === 0) {
      return;
    } else if (log) {
      logger.info(`Deleting ${deletedEntries.length} entries...`);
    }

    await client.bulk({
      index: formatIndexNameForElasticSearch(indexName),
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
    const realIndexName = formatIndexNameForElasticSearch(indexName);
    logger.info(
      `Syncing index ${indexName}${realIndexName !== indexName ? ` (${realIndexName})` : ''}${fromDate ? ` from ${fromDate}` : ''}...`,
    );
  }

  // If there's a fromDate, it means we are doing a simple sync (not a full resync) and therefore need to look at deleted entries
  if (fromDate) {
    await removeDeletedEntries(indexName, fromDate);
  }

  // Sync new/edited entries
  const client = getElasticSearchClient({ throwIfUnavailable: true });
  const adapter = ElasticSearchModelsAdapters[indexName];
  const limit = 5000;
  let modelEntries = [];
  let maxId = undefined;
  let offset = 0;
  do {
    modelEntries = await adapter.findEntriesToIndex({ offset, limit, fromDate, maxId });
    if (modelEntries.length === 0) {
      return;
    } else if (!maxId) {
      maxId = modelEntries[0].id;
    }

    // Send data to ElasticSearch
    await client.bulk({
      index: formatIndexNameForElasticSearch(indexName),
      body: modelEntries.flatMap(entry => [{ index: { _id: entry.id } }, adapter.mapModelInstanceToDocument(entry)]),
    });

    offset += limit;
    if (options.log) {
      logger.info(`... ${offset} entries synced`);
    }
  } while (modelEntries.length === limit);
}

export const getAvailableElasticSearchIndexes = async (): Promise<string[]> => {
  const client = getElasticSearchClient({ throwIfUnavailable: true });
  const indices = await client.cat.indices({ format: 'json' });
  return indices.map(index => index.index);
};

/**
 * Deletes a single index from Elastic search.
 */
export const deleteElasticSearchIndex = async (indexName: ElasticSearchIndexName, { throwIfMissing = true } = {}) => {
  const client = getElasticSearchClient({ throwIfUnavailable: true });
  try {
    await client.indices.delete({ index: formatIndexNameForElasticSearch(indexName) });
  } catch (error) {
    if (error.meta.statusCode === 404 && !throwIfMissing) {
      return;
    } else {
      throw error;
    }
  }
};

export const waitForAllIndexesRefresh = async (prefix = config.elasticSearch.indexesPrefix) => {
  const client = getElasticSearchClient({ throwIfUnavailable: true });
  await client.indices.refresh({ index: !prefix ? '_all' : `${prefix}_*` });
};
