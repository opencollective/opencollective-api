/**
 * The core search mechanism. Queries ultimately end up here after being processed by the GraphQL loader.
 */

import { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types';
import { isEmpty, isNil } from 'lodash';

import { Collective, User } from '../../models';
import { reportErrorToSentry } from '../sentry';

import { ElasticSearchModelAdapter } from './adapters/ElasticSearchModelAdapter';
import { ElasticSearchModelsAdapters } from './adapters';
import { getElasticSearchClient } from './client';
import { formatIndexNameForElasticSearch } from './common';
import { ElasticSearchIndexName, ElasticSearchIndexParams } from './constants';

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

const getIndexConditions = (
  index: ElasticSearchIndexName,
  params: ElasticSearchIndexParams[ElasticSearchIndexName],
) => {
  if (!params) {
    return [];
  }

  switch (index) {
    case ElasticSearchIndexName.COLLECTIVES:
      params = params as ElasticSearchIndexParams[ElasticSearchIndexName.COLLECTIVES];
      return [
        ...(params.type ? [{ term: { type: params.type } }] : []),
        ...(!isNil(params.isHost) ? [{ term: { isHostAccount: params.isHost } }] : []),
        ...(!isNil(params.tags) && !isEmpty(params.tags) ? [{ terms: { tags: params.tags } }] : []),
      ];
    default:
      return [];
  }
};

export type ElasticSearchIndexRequest<T extends ElasticSearchIndexName = ElasticSearchIndexName> = {
  index: T;
  indexParams?: ElasticSearchIndexParams[T];
  forbidPrivate?: boolean;
};

const isSearchableField = (adapter, field) => {
  return adapter.weights[field] !== 0 && ['keyword', 'text'].includes(adapter.mappings.properties[field].type);
};

const addWeightToField = (adapter: ElasticSearchModelAdapter, field: string): string => {
  if (adapter.weights[field] === 1 || adapter.weights[field] === undefined) {
    return field;
  } else {
    return `${field}^${adapter.weights[field]}`;
  }
};

const getIndexPermissions = (
  adapter: ElasticSearchModelAdapter,
  adminOfAccountIds: number[],
  isRoot: boolean,
  forbidPrivate: boolean,
) => {
  if (forbidPrivate) {
    return adapter.getIndexPermissions([]);
  } else if (isRoot) {
    return { default: 'PUBLIC' };
  } else {
    return adapter.getIndexPermissions(adminOfAccountIds);
  }
};

const buildQuery = (
  searchTerm: string,
  indexes: ElasticSearchIndexRequest[],
  remoteUser: User | null,
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
  const adminOfAccountIds = !remoteUser ? [] : remoteUser.getAdministratedCollectiveIds();
  const isRoot = remoteUser && remoteUser.isRoot();

  const query: QueryDslQueryContainer = {
    /* eslint-disable camelcase */
    bool: {
      // Filter to match on CollectiveId/ParentCollectiveId/HostCollectiveId
      ...(accountConditions.length && { filter: accountConditions }),
      // We now build the should array dynamically
      should: indexes.flatMap(({ index, indexParams, forbidPrivate }) => {
        const adapter = ElasticSearchModelsAdapters[index];

        // Avoid searching on private indexes if the user is not an admin of anything
        const permissions = getIndexPermissions(adapter, adminOfAccountIds, isRoot, forbidPrivate);
        if (permissions.default === 'FORBIDDEN') {
          return [];
        }

        // const fields = getSearchableFieldsForIndex(permissions);
        const allFields = Object.keys(adapter.mappings.properties);
        const searchableFields = allFields.filter(field => isSearchableField(adapter, field));
        const publicFields = searchableFields.filter(field => !permissions['fields']?.[field]);

        // Register fetched fields and indexes for later reuse in the aggregation
        allFields.forEach(field => fetchedFields.add(field));
        fetchedIndexes.add(index);

        // Build the query for this index
        return [
          // Public fields
          {
            bool: {
              filter: [
                { term: { _index: formatIndexNameForElasticSearch(index) } },
                ...(permissions.default === 'PUBLIC' ? [] : [permissions.default]),
                ...getIndexConditions(index, indexParams),
              ],
              minimum_should_match: 1,
              should: [
                // Search in all public fields
                {
                  multi_match: {
                    query: searchTerm,
                    type: 'best_fields',
                    operator: 'or',
                    fuzziness: 'AUTO',
                    fields: publicFields.map(field => addWeightToField(adapter, field)),
                  },
                },
                // Search in private fields
                ...Object.entries(permissions['fields'] || {})
                  .filter(([, conditions]) => conditions !== 'FORBIDDEN')
                  .map(([field, conditions]) => {
                    return {
                      bool: {
                        filter: conditions as QueryDslQueryContainer[],
                        must: [
                          { match: { [field]: { query: searchTerm, fuzziness: 'AUTO' } } }, // TODO: Should add field weight here, but it doesn't work with "must" (only "should")
                        ],
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
  requestedIndexes: ElasticSearchIndexRequest[],
  searchTerm: string,
  {
    account,
    host,
    timeoutInSeconds = 30,
    limit = 50,
    user,
  }: {
    account?: Collective;
    host?: Collective;
    timeoutInSeconds?: number;
    limit?: number;
    user?: User;
  } = {},
) => {
  const client = getElasticSearchClient({ throwIfUnavailable: true });
  const { query, fields, indexes } = buildQuery(searchTerm, requestedIndexes, user, account, host);

  // Due to permissions, we may end up searching on no index at all (e.g. trying to search for comments while unauthenticated)
  if (indexes.size === 0) {
    return null;
  }

  try {
    return await client.search({
      /* eslint-disable camelcase */
      timeout: `${timeoutInSeconds}s`,
      index: Array.from(indexes).map(formatIndexNameForElasticSearch).join(','),
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
                    pre_tags: ['<mark>'],
                    post_tags: ['</mark>'],
                    fragment_size: 40,
                    number_of_fragments: 1,
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
  } catch (e) {
    reportErrorToSentry(e, { user, extra: { requestedIndexes, searchTerm, limit, account, host } });
    throw new Error('The search query failed, please try again later');
  }
};
