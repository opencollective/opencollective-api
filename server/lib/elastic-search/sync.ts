/**
 * Functions to sync data between the database and elastic search
 */

import { Client } from '@elastic/elasticsearch';

const client = new Client({
  node: 'http://localhost:9200',
  // auth: {
  //   username: 'elastic',
  //   password: '<ES_PASSWORD>',
  // },
});

export async function createIndices() {
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
        countryISO: { type: 'keyword' },
        description: { type: 'text' },
        longDescription: { type: 'text' },
        website: { type: 'keyword' },
        isActive: { type: 'boolean' },
        isHostAccount: { type: 'boolean' },
        deactivatedAt: { type: 'date' },
        HostCollectiveId: { type: 'keyword' },
        ParentCollectiveId: { type: 'keyword' },
        // TODO: Social accounts
        // TODO: administrated accounts
        // TODO: location
      },
    },
  });
  await client.indices.create({
    index: 'comments',
    mappings: {
      properties: {
        id: { type: 'keyword' },
        CollectiveId: { type: 'keyword' },
        FromCollectiveId: { type: 'keyword' },
        CreatedByUserId: { type: 'keyword' },
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
        CollectiveId: { type: 'keyword' },
        UserId: { type: 'keyword' },
        FromCollectiveId: { type: 'keyword' },
        HostCollectiveId: { type: 'keyword' },
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
        CollectiveId: { type: 'keyword' },
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
        CollectiveId: { type: 'keyword' },
        HostCollectiveId: { type: 'keyword' },
        FromCollectiveId: { type: 'keyword' },
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
        CollectiveId: { type: 'keyword' },
        FromCollectiveId: { type: 'keyword' },
        HostCollectiveId: { type: 'keyword' },
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
        longDescription: { type: 'text' },
        slug: { type: 'keyword' },
        CollectiveId: { type: 'keyword' },
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
        HostCollectiveId: { type: 'keyword' },
        CollectiveId: { type: 'keyword' },
        CreatedByUserId: { type: 'keyword' },
        customData: {
          type: 'nested',
          properties: {
            key: { type: 'keyword' },
            value: { type: 'keyword ' },
          },
        },
      },
    },
  });
}
