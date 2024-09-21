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

async function removeDeletedEntries(model, indexName: ElasticSearchIndexName, fromDate: Date) {
  let offset = 0;
  let deletedEntries = [];
  const pageSize = 20000; // We're only fetching the id, so we can fetch more entries at once
  do {
    deletedEntries = await model.findAll({
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
async function syncModelWithElasticSearch(indexName: ElasticSearchIndexName, options: { fromDate?: Date } = {}) {
  // If there's a fromDate, it means we are doing a simple sync (not a full resync) and therefore need to look at deleted entries
  if (options.fromDate) {
    await removeDeletedEntries(model, indexName, options.fromDate);
  }

  // Sync new/edited entries
  let modelEntries = [];
  let firstProcessedEntry = null;
  let offset = 0;
  const attributes = getModelAttributesForIndex(indexName);
  do {
    modelEntries = await model.findAll({
      attributes,
      raw: true,
      limit: MODELS_PAGE_SIZE,
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
      body: modelEntries.flatMap(entry => [{ index: { _id: entry.id } }, prepareEntryForElasticSearch(entry)]),
    });
    offset += MODELS_PAGE_SIZE;
  } while (modelEntries.length === MODELS_PAGE_SIZE);
}

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

// TODO: sync updatedAt
// TODO: sync deletedAt

// async function syncModelWithElasticSearch(model, indexName, options: { fromDate?: Date } = {}) {
//   // If there's a fromDate, it means we are doing a simple sync (not a full resync) and therefore need to look at deleted entries
//   if (options.fromDate) {
//     await removeDeletedEntries(model, indexName, options.fromDate);
//   }

//   // Sync new/edited entries
//   let modelEntries = [];
//   let firstProcessedEntry = null;
//   let offset = 0;
//   const attributes = getModelAttributesForIndex(indexName);
//   do {
//     modelEntries = await model.findAll({
//       attributes,
//       raw: true,
//       limit: MODELS_PAGE_SIZE,
//       offset,
//       order: [['id', 'DESC']],
//       where: {
//         ...(firstProcessedEntry && { id: { [Op.lte]: firstProcessedEntry.id } }), // To not mess with the pagination in case entries are inserted while we iterate
//         ...(options.fromDate && { updatedAt: { [Op.gt]: options.fromDate } }),
//       },
//     });
//     if (modelEntries.length === 0) {
//       return;
//     } else if (!firstProcessedEntry) {
//       firstProcessedEntry = modelEntries[0];
//     }

//     // Send data to ElasticSearch
//     await client.bulk({
//       index: indexName,
//       body: modelEntries.flatMap(entry => [{ index: { _id: entry.id } }, prepareEntryForElasticSearch(entry)]),
//     });
//     offset += MODELS_PAGE_SIZE;
//   } while (modelEntries.length === MODELS_PAGE_SIZE);
// }

/**
 * Sync all the rows of a model with elastic search.
 *
 * @param options.fromDate Only sync rows updated/deleted after this date
 */
const syncAllModelsWithElasticSearch = async (options: { fromDate?: Date } = {}) => {
  await syncModelWithElasticSearch(models.Collective, ElasticSearchIndexName.COLLECTIVES, options);
  await syncModelWithElasticSearch(models.Comment, ElasticSearchIndexName.COMMENTS, options);
  await syncModelWithElasticSearch(models.Expense, ElasticSearchIndexName.EXPENSES, options);
  await syncModelWithElasticSearch(models.Update, ElasticSearchIndexName.UPDATES, options);
  await syncModelWithElasticSearch(models.Transaction, ElasticSearchIndexName.TRANSACTIONS, options);
  await syncModelWithElasticSearch(models.Order, ElasticSearchIndexName.ORDERS, options);
  await syncModelWithElasticSearch(models.Tier, ElasticSearchIndexName.TIERS, options);
  await syncModelWithElasticSearch(models.HostApplication, ElasticSearchIndexName.HOST_APPLICATIONS, options);
};
