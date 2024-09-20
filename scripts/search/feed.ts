import '../../server/env';

import { Client } from '@elastic/elasticsearch';
import { compact, get, head, mapValues, uniq } from 'lodash';
import LibSanitize from 'sanitize-html';

import { sleep } from '../../server/lib/utils';
import models from '../../server/models';
import { MERCHANT_ID_PATHS } from '../../server/models/Transaction';

const client = new Client({
  node: 'http://localhost:9200',
  // auth: {
  //   username: 'elastic',
  //   password: '<ES_PASSWORD>',
  // },
});

async function createIndices() {
  await client.indices.create({
    index: 'collectives',
    mappings: {
      properties: {
        id: { type: 'keyword' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        slug: { type: 'keyword' },
        name: { type: 'text' },
        type: { type: 'keyword' },
        legalName: { type: 'text' },
        description: { type: 'text' },
        longDescription: { type: 'text' },
        website: { type: 'keyword' },
        isActive: { type: 'boolean' },
        isHostAccount: { type: 'boolean' },
        deactivatedAt: { type: 'date' },
        // TODO: Social accounts
        // TODO: administrated accounts
      },
    },
  });
  await client.indices.create({
    index: 'comments',
    mappings: {
      properties: {
        id: { type: 'keyword' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        html: { type: 'text' },
      },
    },
  });
  await client.indices.create({
    index: 'expenses',
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
      },
    },
  });
  await client.indices.create({
    index: 'updates',
    mappings: {
      properties: {
        id: { type: 'keyword' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        html: { type: 'text' },
      },
    },
  });
  await client.indices.create({
    index: 'transactions',
    mappings: {
      properties: {
        id: { type: 'keyword' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        kind: { type: 'keyword' },
        description: { type: 'text' },
        merchantId: { type: 'keyword' },
        uuid: { type: 'keyword' },
        // TODO: payment provider ID
      },
    },
  });
  await client.indices.create({
    index: 'orders',
    mappings: {
      properties: {
        id: { type: 'keyword' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        description: { type: 'text' },
      },
    },
  });
  await client.indices.create({
    index: 'tiers',
    mappings: {
      properties: {
        id: { type: 'keyword' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        name: { type: 'text' },
        description: { type: 'text' },
      },
    },
  });
  await client.indices.create({
    index: 'hostapplications',
    mappings: {
      properties: {
        id: { type: 'keyword' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        message: { type: 'text' },
      },
    },
  });
}

const SPECIAL_COLUMNS = {
  transactions: {
    merchantId: {
      dbFields: ['kind', 'data'],
      transform: transaction =>
        head(compact(MERCHANT_ID_PATHS[transaction.kind]?.map(path => get(transaction, path)))) || null,
    },
  },
};

async function modelToIndex(model, indexName) {
  const index = await client.indices.get({ index: indexName });
  const indexProperties = index[indexName].mappings.properties;
  const attributes = uniq(
    Object.keys(indexProperties).flatMap(key => {
      if (SPECIAL_COLUMNS[indexName]?.[key]) {
        return SPECIAL_COLUMNS[indexName][key].dbFields;
      } else {
        return key;
      }
    }),
  );

  const modelEntries = await model.findAll({ attributes, raw: true });
  if (modelEntries.length === 0) {
    return;
  }
  await client.bulk({
    index: indexName,
    body: modelEntries.flatMap(entry => [
      { index: { _id: entry.id } },
      {
        ...mapValues(entry, (value, key) => {
          if (['html', 'longDescription'].includes(key)) {
            return LibSanitize(value, { allowedTags: [], allowedAttributes: {} }); // TODO: Use native elastic search HTML stripping
          } else if (indexProperties[key]) {
            return value;
          }
        }),

        ...mapValues(SPECIAL_COLUMNS[indexName], column => {
          return column.transform(entry);
        }),
      },
    ]),
  });
}

async function feedData() {
  await modelToIndex(models.Collective, 'collectives');
  await modelToIndex(models.Comment, 'comments');
  await modelToIndex(models.Expense, 'expenses');
  await modelToIndex(models.Update, 'updates');
  await modelToIndex(models.Transaction, 'transactions');
  await modelToIndex(models.Order, 'orders');
  await modelToIndex(models.Tier, 'tiers');
  await modelToIndex(models.HostApplication, 'hostapplications');
}

async function run() {
  // Ping the Elasticsearch cluster
  console.log('Checking Elasticsearch cluster...');
  const pingResult = await client.ping();
  console.log('Elasticsearch cluster is up!');

  // Delete all existing indices
  const indices = await client.cat.indices({ format: 'json' });
  for (const index of indices) {
    await client.indices.delete({ index: index.index });
  }

  await createIndices();

  await feedData();

  // check index size
  // const indexStats = await client.indices.stats({ index: 'collectives' });
  // console.log(JSON.stringify(indexStats, null, 2));
}

run()
  .catch(console.error)
  .then(() => process.exit(0));
