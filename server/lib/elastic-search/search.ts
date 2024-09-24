/**
 * The core search mechanism. Queries ultimately end up here after being processed by the GraphQL loader.
 */

import _, { remove, uniq } from 'lodash';

import { Collective } from '../../models';

import { ElasticSearchModelsAdapters } from './adapters';
import { getElasticSearchClient } from './client';
import { ElasticSearchIndexName } from './constants';

/**
 * Enforce some conditions to match only entities that are related to this account or host.
 */
const getAccountConditions = (account: Collective, host: Collective) => {
  const conditions = [];
  if (account) {
    conditions.push(
      { term: { FromCollectiveId: account.id } },
      { term: { CollectiveId: account.id } },
      { term: { ParentCollectiveId: account.id } },
    );
  }
  if (host) {
    conditions.push({ term: { HostCollectiveId: host.id } });
  }

  return conditions;
};

export const elasticSearchGlobalSearch = async (
  indexes: ElasticSearchIndexName[],
  searchTerm: string,
  limit: number,
  adminOfAccountIds: number[],
  account: Collective,
  host: Collective,
) => {
  const client = getElasticSearchClient({ throwIfUnavailable: true });
  const accountConditions = getAccountConditions(account, host);

  // TODO: generate this list from fields actually fetched
  const allFetchedFields = uniq(
    indexes.flatMap(index => {
      const adapter = ElasticSearchModelsAdapters[index];
      return Object.keys(adapter.mappings.properties);
    }),
  );

  // TODO: handle private indexes
  const publicIndexes = indexes.filter(index => ElasticSearchModelsAdapters[index].permissions.default === 'PUBLIC');

  return client.search({
    /* eslint-disable camelcase */
    index: indexes.join(','),
    body: {
      size: 0, // We don't need hits at the top level
      query: {
        bool: {
          // Filter to match on CollectiveId/ParentCollectiveId/HostCollectiveId
          ...(accountConditions.length && { filter: accountConditions }),
          // We now build the should array dynamically
          should: publicIndexes.map(index => {
            const adapter = ElasticSearchModelsAdapters[index];
            const privateFields = adapter.permissions.fields ? Object.keys(adapter.permissions.fields) : [];
            const fields = Object.keys(adapter.mappings.properties);
            remove(fields, field => privateFields.includes(field));
            remove(fields, field => !['keyword', 'text'].includes(adapter.mappings.properties[field].type));
            // TODO handle private fields
            // TODO fields weights
            return {
              bool: {
                filter: [{ term: { _index: index } }],
                must: [
                  {
                    multi_match: {
                      query: searchTerm,
                      type: 'best_fields',
                      operator: 'or',
                      fuzziness: 'AUTO',
                      fields,
                    },
                  },
                ],
              },
            };
          }),
        },
      },
      aggs: {
        by_index: {
          terms: {
            field: '_index',
            size: indexes.length, // Make sure we get all indexes
          },
          aggs: {
            top_hits_by_index: {
              top_hits: {
                size: limit,
                _source: {
                  // We only need to retrieve the IDs, the rest will be fetched by the loaders
                  includes: ['id', 'uuid'],
                },
                highlight: {
                  pre_tags: ['<em>'],
                  post_tags: ['</em>'],
                  fragment_size: 150,
                  number_of_fragments: 3,
                  fields: allFetchedFields.reduce((acc, field) => {
                    acc[field] = {};
                    return acc;
                  }, {}),
                },
              },
            },
          },
        },
      },
    },
    /* eslint-enable camelcase */
  });
};
