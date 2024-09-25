/**
 * The core search mechanism. Queries ultimately end up here after being processed by the GraphQL loader.
 */

import { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types';

import { Collective } from '../../models';

import { ElasticSearchModelAdapter } from './adapters/ElasticSearchModelAdapter';
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

  return conditions;
};

const getSearchableFieldsForIndex = (adapter: ElasticSearchModelAdapter) => {
  const getField = field => adapter.mappings.properties[field];
  const getFieldPermissions = field => adapter.permissions.fields[field];
  const isSupportedType = field => ['keyword', 'text'].includes(getField(field).type);
  const fieldMatchPermission = (field, permission) => getFieldPermissions(field).includes(permission);

  const allSearchableFields = Object.keys(adapter.mappings.properties).filter(isSupportedType);
  const privateFields = adapter.permissions.fields ? Object.keys(adapter.permissions.fields) : [];
  const publicFields = allSearchableFields.filter(field => !privateFields.includes(field));
  const hostAdminFields = privateFields.filter(field => fieldMatchPermission(field, 'HOST_ADMIN'));
  const accountAdminFields = privateFields.filter(field => fieldMatchPermission(field, 'ACCOUNT_ADMIN'));
  const fromAccountAdminFields = privateFields.filter(field => fieldMatchPermission(field, 'FROM_ACCOUNT_ADMIN'));

  return {
    public: publicFields,
    hostAdmin: hostAdminFields,
    accountAdmin: accountAdminFields,
    fromAccountAdmin: fromAccountAdminFields,
  };
};

const getPrivateFieldsConditions = (
  adminOfAccountIds: number[],
  searchTerm: string,
  fields: string[],
  CollectiveIdColumn: 'HostCollectiveId' | 'CollectiveId' | 'FromCollectiveId',
): QueryDslQueryContainer => {
  if (!adminOfAccountIds.length || !fields.length) {
    return null;
  } else {
    return {
      /* eslint-disable camelcase */
      bool: {
        filter: [{ terms: { [CollectiveIdColumn]: adminOfAccountIds } }],
        must: [
          {
            multi_match: {
              query: searchTerm,
              type: 'best_fields',
              operator: 'or',
              fuzziness: 'AUTO',
              fields: fields,
            },
          },
        ],
      },
    };
    /* eslint-enable camelcase */
  }
};

/**
 * Filters to apply to the query to match only entities that the user has access to, based
 * on the `adapter.default` permissions.
 */
const getIndexDefaultAccountPermissionsFilter = (adapter, adminOfAccountIds): QueryDslQueryContainer[] => {
  const conditions = [];
  if (adapter.permissions.default === 'PUBLIC') {
    return [];
  }

  if (adapter.permissions.default.includes('HOST_ADMIN')) {
    conditions.push({ terms: { HostCollectiveId: adminOfAccountIds } });
  }
  if (adapter.permissions.default.includes('ACCOUNT_ADMIN')) {
    conditions.push({ terms: { CollectiveId: adminOfAccountIds } });
  }
  if (adapter.permissions.default.includes('FROM_ACCOUNT_ADMIN')) {
    conditions.push({ terms: { FromCollectiveId: adminOfAccountIds } });
  }

  if (conditions.length === 0) {
    return [];
  } else if (conditions.length === 1) {
    return conditions;
  } else {
    // eslint-disable-next-line camelcase
    return [{ bool: { should: conditions, minimum_should_match: 1 } }];
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
        if (adapter.permissions.default !== 'PUBLIC' && !adminOfAccountIds.length) {
          return [];
        }

        // Register fetched fields and indexes for later reuse in the aggregation
        const fields = getSearchableFieldsForIndex(adapter);
        Object.values(fields).forEach(fieldList => fieldList.forEach(fetchedFields.add, fetchedFields));
        fetchedIndexes.add(index);

        // Build the query for this index
        return [
          // Public fields
          {
            bool: {
              filter: [
                { term: { _index: index } },
                ...getIndexDefaultAccountPermissionsFilter(adapter, adminOfAccountIds),
              ],
              must: [
                {
                  multi_match: {
                    query: searchTerm,
                    type: 'best_fields',
                    operator: 'or',
                    fuzziness: 'AUTO',
                    fields: fields.public,
                  },
                },
              ],
            },
          },
          // Private fields
          ...[
            getPrivateFieldsConditions(adminOfAccountIds, searchTerm, fields.hostAdmin, 'HostCollectiveId'),
            getPrivateFieldsConditions(adminOfAccountIds, searchTerm, fields.accountAdmin, 'CollectiveId'),
            getPrivateFieldsConditions(adminOfAccountIds, searchTerm, fields.fromAccountAdmin, 'FromCollectiveId'),
          ].filter(Boolean),
        ];
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
