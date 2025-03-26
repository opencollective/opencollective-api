/**
 * Functions to sync data between the database and open search
 */

import config from 'config';

import { Op } from '../../models';
import logger from '../logger';

import { OpenSearchModelsAdapters } from './adapters';
import { getOpenSearchClient } from './client';
import { formatIndexNameForOpenSearch } from './common';
import { OpenSearchIndexName } from './constants';

export async function createOpenSearchIndex(indexName: OpenSearchIndexName) {
  const client = getOpenSearchClient({ throwIfUnavailable: true });
  const adapter = OpenSearchModelsAdapters[indexName];
  if (!adapter) {
    throw new Error(`No OpenSearch adapter found for index ${indexName}`);
  }

  return client.indices.create({
    index: formatIndexNameForOpenSearch(indexName),
    body: { mappings: adapter['mappings'], settings: adapter['settings'] },
  });
}

async function removeDeletedEntries(indexName: OpenSearchIndexName, fromDate: Date, { log = false } = {}) {
  const client = getOpenSearchClient({ throwIfUnavailable: true });
  const adapter = OpenSearchModelsAdapters[indexName];
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
      index: formatIndexNameForOpenSearch(indexName),
      body: deletedEntries.flatMap(entry => [{ delete: { _id: entry.id } }]),
    });
    offset += pageSize;
  } while (deletedEntries.length === pageSize);
}

export async function syncOpenSearchIndex(
  indexName: OpenSearchIndexName,
  options: { fromDate?: Date; log?: boolean } = {},
) {
  const { fromDate } = options;

  if (options.log) {
    const realIndexName = formatIndexNameForOpenSearch(indexName);
    logger.info(
      `Syncing index ${indexName}${realIndexName !== indexName ? ` (${realIndexName})` : ''}${fromDate ? ` from ${fromDate}` : ''}...`,
    );
  }

  // If there's a fromDate, it means we are doing a simple sync (not a full resync) and therefore need to look at deleted entries
  if (fromDate) {
    await removeDeletedEntries(indexName, fromDate);
  }

  // Sync new/edited entries
  const client = getOpenSearchClient({ throwIfUnavailable: true });
  const adapter = OpenSearchModelsAdapters[indexName];
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

    // Send data to OpenSearch
    await client.bulk({
      index: formatIndexNameForOpenSearch(indexName),
      body: modelEntries.flatMap(entry => [{ index: { _id: entry.id } }, adapter.mapModelInstanceToDocument(entry)]),
    });

    offset += limit;
    if (options.log) {
      logger.info(`... ${offset} entries synced`);
    }
  } while (modelEntries.length === limit);
}

export const getAvailableOpenSearchIndexes = async (): Promise<string[]> => {
  const client = getOpenSearchClient({ throwIfUnavailable: true });
  const indices = await client.cat.indices({ format: 'json' });
  return indices.body.map(index => index.index);
};

/**
 * Deletes a single index from OpenSearch.
 */
export const removeOpenSearchIndex = async (indexName: OpenSearchIndexName, { throwIfMissing = true } = {}) => {
  const client = getOpenSearchClient({ throwIfUnavailable: true });
  try {
    await client.indices.delete({ index: formatIndexNameForOpenSearch(indexName) });
  } catch (error) {
    if (error.meta.statusCode === 404 && !throwIfMissing) {
      return;
    } else {
      throw error;
    }
  }
};

export const waitForAllIndexesRefresh = async (prefix = config.opensearch.indexesPrefix) => {
  const client = getOpenSearchClient({ throwIfUnavailable: true });
  await client.indices.refresh({ index: !prefix ? '_all' : `${prefix}_*` });
};
