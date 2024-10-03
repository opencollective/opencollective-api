/**
 * The core search mechanism. Queries ultimately end up here after being processed by the GraphQL loader.
 */

import { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types';

import { Collective } from '../../models';

import { ElasticSearchModelsAdapters } from './adapters';
import { getElasticSearchClient } from './client';
import { ElasticSearchIndexName } from './constants';

/**
 * Enforce some conditions to match only entities that are related to this account or host.
 */
const getAccountFilterConditions = (account: Collective, host: Collective) => {
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

  if (conditions.length < 2) {
    return conditions;
  } else {
    return [
      { bool: { minimum_should_match: 1, should: conditions } }, // eslint-disable-line camelcase
    ];
  }
};

const buildQuery = (
  searchTerm: string,
  indexes: ElasticSearchIndexName[],
  adminOfAccountIds: number[],
  account: Collective,
  host: Collective,
): {
  query: QueryDslQueryContainer;
  fields: Set<string>;
  indexes: Set<ElasticSearchIndexName>;
} => {
  const accountConditions = getAccountFilterConditions(account, host);
  const fetchedFields = new Set<string>();
  const fetchedIndexes = new Set<ElasticSearchIndexName>();
  const query: QueryDslQueryContainer = {
    /* eslint-disable camelcase */
    bool: {
      // Filter to match on CollectiveId/ParentCollectiveId/HostCollectiveId
      ...(accountConditions.length && { filter: accountConditions }),
      // We now build the should array dynamically
      should: indexes.flatMap(index => {
        const adapter = ElasticSearchModelsAdapters[index];

        // Avoid searching on private indexes if the user is not an admin of anything
        const permissions = adapter.getIndexPermissions(adminOfAccountIds);
        if (permissions.default === 'FORBIDDEN') {
          return [];
        }

        // const fields = getSearchableFieldsForIndex(permissions);
        const getField = field => adapter.mappings.properties[field];
        const isSearchableField = field => ['keyword', 'text'].includes(getField(field).type);
        const allFields = Object.keys(adapter.mappings.properties);
        const searchableFields = allFields.filter(isSearchableField);
        const publicFields = searchableFields.filter(field => !permissions.fields?.[field]);

        // Register fetched fields and indexes for later reuse in the aggregation
        allFields.forEach(field => fetchedFields.add(field));
        fetchedIndexes.add(index);

        // Build the query for this index
        return [
          // Public fields
          {
            bool: {
              filter: [{ term: { _index: index } }, ...(permissions.default === 'PUBLIC' ? [] : [permissions.default])],
              minimum_should_match: 1,
              should: [
                {
                  multi_match: {
                    query: searchTerm,
                    type: 'best_fields',
                    operator: 'or',
                    fuzziness: 'AUTO',
                    fields: publicFields,
                  },
                },
                ...Object.entries(permissions.fields || {})
                  .filter(([, conditions]) => conditions !== 'FORBIDDEN')
                  .map(([field, conditions]) => {
                    return {
                      bool: {
                        filter: conditions as QueryDslQueryContainer[],
                        must: [{ match: { [field]: { query: searchTerm, fuzziness: 'AUTO' } } }],
                      },
                    } satisfies QueryDslQueryContainer;
                  }),
              ],
            },
          },
        ] as QueryDslQueryContainer[];
      }),
    },
    /* eslint-enable camelcase */
  };

  return { query, fields: fetchedFields, indexes: fetchedIndexes };
};

export const elasticSearchGlobalSearch = async (
  requestedIndexes: ElasticSearchIndexName[],
  searchTerm: string,
  limit: number,
  adminOfAccountIds: number[],
  account: Collective,
  host: Collective,
) => {
  const client = getElasticSearchClient({ throwIfUnavailable: true });
  const { query, fields, indexes } = buildQuery(searchTerm, requestedIndexes, adminOfAccountIds, account, host);

  return client.search({
    /* eslint-disable camelcase */
    index: Array.from(indexes).join(','),
    body: {
      size: 0, // We don't need hits at the top level
      query,
      // Aggregate results by index, keeping only `limit` top hits per index
      aggs: {
        by_index: {
          terms: {
            field: '_index',
            size: indexes.size, // Make sure we get all indexes
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
                  fields: Array.from(fields).reduce((acc, field) => {
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
