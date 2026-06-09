/**
 * The core search mechanism. Queries ultimately end up here after being processed by the GraphQL loader.
 */

import { Search_Request as SearchRequest } from '@opensearch-project/opensearch/api';
import { QueryContainer } from '@opensearch-project/opensearch/api/_types/_common.query_dsl';
import { isEmpty, isNil } from 'lodash';

import { Collective, User } from '../../models';
import { reportErrorToSentry } from '../sentry';

import { OpenSearchModelAdapter } from './adapters/OpenSearchModelAdapter';
import { OpenSearchModelsAdapters } from './adapters';
import { getOpenSearchClient } from './client';
import { formatIndexNameForOpenSearch } from './common';
import { OpenSearchIndexName, OpenSearchIndexParams } from './constants';

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

const getIndexConditions = (index: OpenSearchIndexName, params: OpenSearchIndexParams[OpenSearchIndexName]) => {
  if (!params) {
    return [];
  }

  switch (index) {
    case OpenSearchIndexName.COLLECTIVES:
      params = params as OpenSearchIndexParams[OpenSearchIndexName.COLLECTIVES];
      return [
        ...(params.type ? [{ term: { type: params.type } }] : []),
        ...(!isNil(params.isHost) ? [{ term: { hasMoneyManagement: params.isHost } }] : []),
        ...(!isNil(params.tags) && !isEmpty(params.tags) ? [{ terms: { tags: params.tags } }] : []),
      ];
    default:
      return [];
  }
};

export type OpenSearchIndexRequest<T extends OpenSearchIndexName = OpenSearchIndexName> = {
  index: T;
  indexParams?: OpenSearchIndexParams[T];
  forbidPrivate?: boolean;
};

const isSearchableField = (adapter, field) => {
  return adapter.weights[field] !== 0 && ['keyword', 'text'].includes(adapter.mappings.properties[field].type);
};

const addWeightToField = (adapter: OpenSearchModelAdapter, field: string): string => {
  if (adapter.weights[field] === 1 || adapter.weights[field] === undefined) {
    return field;
  } else {
    return `${field}^${adapter.weights[field]}`;
  }
};

const getIndexPermissions = (
  adapter: OpenSearchModelAdapter,
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
  indexes: OpenSearchIndexRequest[],
  remoteUser: User | null,
  account: Collective,
  host: Collective,
): {
  query: QueryContainer;
  /** All fields for which the search term was used. Does not include account constraints */
  searchedFields: Set<string>;
  /** All indexes that were fetched */
  indexes: Set<OpenSearchIndexName>;
} => {
  const accountConditions = getAccountFilterConditions(account, host);
  const searchedFields = new Set<string>();
  const fetchedIndexes = new Set<OpenSearchIndexName>();
  const adminOfAccountIds = !remoteUser ? [] : remoteUser.getAdministratedCollectiveIds();
  const isRoot = remoteUser && remoteUser.isRoot();

  const query: QueryContainer = {
    /* eslint-disable camelcase */
    bool: {
      // Filter to match on CollectiveId/ParentCollectiveId/HostCollectiveId
      ...(accountConditions.length && { filter: accountConditions }),
      // We now build the should array dynamically
      should: indexes.flatMap(({ index, indexParams, forbidPrivate }) => {
        const adapter = OpenSearchModelsAdapters[index];

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
        searchableFields.forEach(field => searchedFields.add(field));
        fetchedIndexes.add(index);

        // Build the query for this index
        return [
          // Public fields
          {
            bool: {
              filter: [
                { term: { _index: formatIndexNameForOpenSearch(index) } },
                ...(permissions.default === 'PUBLIC' ? [] : [permissions.default]),
                ...getIndexConditions(index, indexParams),
              ],
              minimum_should_match: 1,
              should: [
                // Search in all public text fields with fuzzy match
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
                        filter: conditions as QueryContainer[],
                        must: [
                          { match: { [field]: { query: searchTerm, fuzziness: 'AUTO' } } }, // TODO: Should add field weight here, but it doesn't work with "must" (only "should")
                        ],
                      },
                    } satisfies QueryContainer;
                  }),
              ],
            },
          },
        ] as QueryContainer[];
      }),
    },
    /* eslint-enable camelcase */
  };

  return { query, searchedFields, indexes: fetchedIndexes };
};

const getHighlightConfig = (searchedFields: Set<string>) => {
  return {
    /* eslint-disable camelcase */
    pre_tags: ['<mark>'],
    post_tags: ['</mark>'],
    fragment_size: 40,
    number_of_fragments: 1,
    fields: Array.from(searchedFields).reduce((acc, field) => {
      acc[field] = {};
      return acc;
    }, {}),
  };
};

export const openSearchMultiIndexGlobalSearch = async (
  requestedIndexes: OpenSearchIndexRequest[],
  searchTerm: string,
  {
    account,
    host,
    timeoutInSeconds = 30,
    limit = 50,
    offset = 0,
    user,
  }: {
    account?: Collective;
    host?: Collective;
    timeoutInSeconds?: number;
    limit?: number;
    offset?: number;
    user?: User;
  } = {},
) => {
  const client = getOpenSearchClient({ throwIfUnavailable: true });
  const { query, searchedFields, indexes } = buildQuery(searchTerm, requestedIndexes, user, account, host);

  // Due to permissions, we may end up searching on no index at all (e.g. trying to search for comments while unauthenticated)
  if (indexes.size === 0) {
    return null;
  }

  try {
    return await client.search({
      /* eslint-disable camelcase */
      timeout: `${timeoutInSeconds}s`,
      index: Array.from(indexes).map(formatIndexNameForOpenSearch).join(','),
      body: {
        size: 0, // We don't need hits at the top level
        query,
        min_score: 0.0001, // Ignore results that fulfill the accounts criteria but don't match the search term
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
                  from: offset,
                  _source: {
                    // We only need to retrieve the IDs, the rest will be fetched by the loaders
                    includes: ['id', 'uuid'],
                  },
                  highlight: getHighlightConfig(searchedFields),
                },
              },
            },
          },
        },
      },
      /* eslint-enable camelcase */
    } as SearchRequest);
  } catch (e) {
    reportErrorToSentry(e, { user, extra: { requestedIndexes, searchTerm, limit, account, host } });
    throw new Error('The search query failed, please try again later');
  }
};

export const openSearchSingleIndexSearch = async (
  request: OpenSearchIndexRequest,
  searchTerm: string,
  {
    account,
    host,
    timeoutInSeconds = 30,
    limit = 50,
    offset = 0,
    user,
  }: {
    account?: Collective;
    host?: Collective;
    timeoutInSeconds?: number;
    limit?: number;
    offset?: number;
    user?: User;
  } = {},
) => {
  const client = getOpenSearchClient({ throwIfUnavailable: true });
  const { query, searchedFields, indexes } = buildQuery(searchTerm, [request], user, account, host);

  // Due to permissions, we may end up searching on no index at all (e.g. trying to search for comments while unauthenticated)
  if (indexes.size === 0) {
    return null;
  }

  try {
    return await client.search({
      /* eslint-disable camelcase */
      timeout: `${timeoutInSeconds}s`,
      index: Array.from(indexes).map(formatIndexNameForOpenSearch).join(','),
      body: {
        from: offset,
        size: limit,
        query,
        min_score: 0.0001, // Ignore results that fulfill the accounts criteria but don't match the search term
        _source: {
          // We only need to retrieve the IDs, the rest will be fetched by the loaders
          includes: ['id', 'uuid'],
        },
        highlight: getHighlightConfig(searchedFields),
      },
      /* eslint-enable camelcase */
    } as SearchRequest);
  } catch (e) {
    reportErrorToSentry(e, { user, extra: { request, searchTerm, limit, account, host } });
    throw new Error('The search query failed, please try again later');
  }
};
