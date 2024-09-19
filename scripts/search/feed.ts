import { Client } from '@elastic/elasticsearch';

import { sleep } from '../../server/lib/utils';
import models from '../../server/models';

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
        description: { type: 'text' },
        longDescription: { type: 'text' },
        website: { type: 'keyword' },
        isActive: { type: 'boolean' },
        isHostAccount: { type: 'boolean' },
        // TODO: Social accounts
        deactivatedAt: { type: 'date' },
      },
    },
  });
}

async function feedData() {
  const collectives = await models.Collective.findAll();
  await client.bulk({
    index: 'collectives',
    body: collectives.flatMap(collective => [
      { index: { _id: collective.id } },
      {
        id: collective.id,
        createdAt: collective.createdAt,
        updatedAt: collective.updatedAt,
        slug: collective.slug,
        name: collective.name,
        description: collective.description,
        longDescription: collective.longDescription,
        website: collective.website,
        isActive: collective.isActive,
        isHostAccount: collective.isHostAccount,
        deactivatedAt: collective.deactivatedAt,
      },
    ]),
  });
}

async function run() {
  // Ping the Elasticsearch cluster
  const pingResult = await client.ping();
  console.log('Elasticsearch cluster is up!');

  // Delete all existing indices
  // const indices = await client.cat.indices({ format: 'json' });
  // for (const index of indices) {
  //   await client.indices.delete({ index: index.index });
  // }

  // await createIndices();

  // await feedData();

  // check index size
  // const indexStats = await client.indices.stats({ index: 'collectives' });
  // console.log(JSON.stringify(indexStats, null, 2));

  // Search for the document
  const searchResult = await client.search({
    index: 'collectives',
    query: {
      match: { name: 'test' },
    },
  });

  console.log(JSON.stringify(searchResult, null, 2));
}

run()
  .catch(console.error)
  .then(() => process.exit(0));
