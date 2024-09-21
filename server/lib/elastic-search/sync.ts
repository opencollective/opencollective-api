/**
 * Functions to sync data between the database and elastic search
 */

import { Client } from '@elastic/elasticsearch';
import { uniq } from 'lodash';

import models, { Op } from '../../models';

import { ElasticSearchCollectivesAdapter } from './adapters/ElasticSearchCollectivesAdapter';
import { ElasticSearchIndexName } from './const';
import { ElasticSearchModelToIndexAdapter } from './ElasticSearchModelToIndexAdapter';

const client = new Client({
  node: 'http://localhost:9200',
  // auth: {
  //   username: 'elastic',
  //   password: '<ES_PASSWORD>',
  // },
});

const Adapters: Record<ElasticSearchIndexName, ElasticSearchModelToIndexAdapter> = {
  [ElasticSearchIndexName.COLLECTIVES]: new ElasticSearchCollectivesAdapter(),
};

export async function createIndices() {
  for (const adapter of Object.values(Adapters)) {
    await client.indices.create({
      index: adapter.index,
      body: { mappings: adapter.mappings, settings: adapter.settings },
    });
  }
}

async function removeDeletedEntries(indexName: ElasticSearchIndexName, fromDate: Date) {
  const adapter = Adapters[indexName];
  const pageSize = 20000; // We're only fetching the id, so we can fetch more entries at once
  let offset = 0;
  let deletedEntries = [];
  do {
    deletedEntries = await adapter.model.findAll({
      attributes: ['id'],
      include: adapter.getAttributesForFindAll?.(),
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

async function syncModelWithElasticSearch(indexName: ElasticSearchIndexName, options: { fromDate?: Date } = {}) {
  // If there's a fromDate, it means we are doing a simple sync (not a full resync) and therefore need to look at deleted entries
  if (options.fromDate) {
    await removeDeletedEntries(indexName, options.fromDate);
  }

  // Sync new/edited entries
  const adapter = Adapters[indexName];
  const limit = 5000;
  let modelEntries = [];
  let firstProcessedEntry = null;
  let offset = 0;
  do {
    modelEntries = await adapter.model.findAll({
      attributes: adapter.getAttributesForFindAll(),
      raw: true,
      limit,
      offset,
      order: [['id', 'DESC']],
      where: {
        ...(firstProcessedEntry && { id: { [Op.lte]: firstProcessedEntry.id } }), // To not mess with the pagination in case entries are inserted while we iterate
        ...(options.fromDate && { updatedAt: { [Op.gt]: options.fromDate } }),
      },
    });
    if (modelEntries.length === 0) {
      return;
    } else if (!firstProcessedEntry) {
      firstProcessedEntry = modelEntries[0];
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
export const syncAllModelsWithElasticSearch = async (options: { fromDate?: Date } = {}) => {
  await syncModelWithElasticSearch(ElasticSearchIndexName.COLLECTIVES, options);
  await syncModelWithElasticSearch(ElasticSearchIndexName.COMMENTS, options);
  await syncModelWithElasticSearch(ElasticSearchIndexName.EXPENSES, options);
  await syncModelWithElasticSearch(ElasticSearchIndexName.UPDATES, options);
  await syncModelWithElasticSearch(ElasticSearchIndexName.TRANSACTIONS, options);
  await syncModelWithElasticSearch(ElasticSearchIndexName.ORDERS, options);
  await syncModelWithElasticSearch(ElasticSearchIndexName.TIERS, options);
  await syncModelWithElasticSearch(ElasticSearchIndexName.HOST_APPLICATIONS, options);
};

export const deleteAllExistingIndices = async () => {
  const indices = await client.cat.indices({ format: 'json' });
  for (const index of indices) {
    await client.indices.delete({ index: index.index });
  }
};

// ---- old ----

const IndexesDefinitions: Record<
  ElasticSearchIndexName,
  {
    indexParams: Omit<Parameters<typeof client.indices.create>[0], 'index'>;
  }
> = {
  [ElasticSearchIndexName.COLLECTIVES]: {
    indexParams: {
      mappings: {
        properties: {
          id: { type: 'keyword' },
          createdAt: { type: 'date' },
          updatedAt: { type: 'date' },
          slug: { type: 'keyword' },
          name: { type: 'text' },
          type: { type: 'keyword' },
          legalName: { type: 'text' },
          countryISO: { type: 'keyword' },
          description: { type: 'text' },
          longDescription: { type: 'text' },
          website: { type: 'keyword' },
          isActive: { type: 'boolean' },
          isHostAccount: { type: 'boolean' },
          deactivatedAt: { type: 'date' },
          // Relationships
          HostCollectiveId: { type: 'keyword' },
          ParentCollectiveId: { type: 'keyword' },
          // TODO: Social accounts
          // TODO: administrated accounts
          // TODO: location
        },
      },
    },
  },

  [ElasticSearchIndexName.COMMENTS]: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        html: { type: 'text' },
        // Relationships
        CollectiveId: { type: 'keyword' },
        FromCollectiveId: { type: 'keyword' },
        HostCollectiveId: { type: 'keyword' },
        CreatedByUserId: { type: 'keyword' },
      },
    },
  },

  [ElasticSearchIndexName.EXPENSES]: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        incurredAt: { type: 'date' },
        description: { type: 'text' },
        amount: { type: 'float' },
        currency: { type: 'keyword' },
        status: { type: 'keyword' },
        // Relationships
        UserId: { type: 'keyword' },
        FromCollectiveId: { type: 'keyword' },
        HostCollectiveId: { type: 'keyword' },
        CollectiveId: { type: 'keyword' },
      },
    },
  },

  [ElasticSearchIndexName.UPDATES]: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        html: { type: 'text' },
        // Relationships
        CollectiveId: { type: 'keyword' },
        HostCollectiveId: { type: 'keyword' },
      },
    },
  },

  [ElasticSearchIndexName.TRANSACTIONS]: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        kind: { type: 'keyword' },
        description: { type: 'text' },
        uuid: { type: 'keyword' },
        // Special fields
        merchantId: { type: 'keyword' },
        // Relationships
        CollectiveId: { type: 'keyword' },
        HostCollectiveId: { type: 'keyword' },
        FromCollectiveId: { type: 'keyword' },
      },
    },
  },

  [ElasticSearchIndexName.ORDERS]: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        description: { type: 'text' },
        // Relationships
        CollectiveId: { type: 'keyword' },
        FromCollectiveId: { type: 'keyword' },
        HostCollectiveId: { type: 'keyword' },
      },
    },
  },

  [ElasticSearchIndexName.TIERS]: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        name: { type: 'text' },
        description: { type: 'text' },
        longDescription: { type: 'text' },
        slug: { type: 'keyword' },
        // Relationships
        CollectiveId: { type: 'keyword' },
        HostCollectiveId: { type: 'keyword' },
      },
    },
  },

  [ElasticSearchIndexName.HOST_APPLICATIONS]: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        message: { type: 'text' },
        // Relationships
        HostCollectiveId: { type: 'keyword' },
        CollectiveId: { type: 'keyword' },
        CreatedByUserId: { type: 'keyword' },
      },
    },
  },
} as const;
