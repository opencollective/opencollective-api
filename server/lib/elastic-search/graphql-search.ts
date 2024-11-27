/**
 * This file contains the logic to bind the ElasticSearch functionality to the GraphQL API.
 */

import DataLoader from 'dataloader';
import { groupBy, mapKeys, mapValues } from 'lodash';

import { SearchResultBucket } from '../../graphql/loaders/search';
import { idEncode } from '../../graphql/v2/identifiers';
import { Collective, User } from '../../models';

import { ElasticSearchIndexName } from './constants';

/**
 * Returns a unique identifier for the ElasticSearch query, which can be used to batch multiple queries together.
 */
export const getElasticSearchQueryId = (
  user: User | null,
  host: Collective,
  account: Collective,
  searchTerm: string,
) => {
  return `${user?.id || 'public'}-host_${host?.id || 'all'}-account_${account?.id || 'all'}-${searchTerm}`;
};

const GraphQLSearchResultsStrategy: Record<
  ElasticSearchIndexName,
  {
    // A loader to use for loading entities from the (optionally encoded) ID
    loadMany: (req, ids) => DataLoader<unknown, unknown>;
    // An optional function to encode the ID for use in the GraphQL API
    getGraphQLId: (result: Record<string, unknown>) => string;
  }
> = {
  [ElasticSearchIndexName.COLLECTIVES]: {
    getGraphQLId: (result: Record<string, unknown>) => idEncode(parseInt(result['id'] as string), 'account'),
    loadMany: (req, ids) => req.loaders.Collective.byId.loadMany(ids),
  },
  [ElasticSearchIndexName.COMMENTS]: {
    getGraphQLId: (result: Record<string, unknown>) => idEncode(parseInt(result['id'] as string), 'comment'),
    loadMany: (req, ids) => req.loaders.Comment.byId.loadMany(ids),
  },
  [ElasticSearchIndexName.EXPENSES]: {
    getGraphQLId: (result: Record<string, unknown>) => idEncode(parseInt(result['id'] as string), 'expense'),
    loadMany: (req, ids) => req.loaders.Expense.byId.loadMany(ids),
  },
  [ElasticSearchIndexName.HOST_APPLICATIONS]: {
    getGraphQLId: (result: Record<string, unknown>) => idEncode(parseInt(result['id'] as string), 'host-application'),
    loadMany: (req, ids) => req.loaders.HostApplication.byId.loadMany(ids),
  },
  [ElasticSearchIndexName.ORDERS]: {
    getGraphQLId: (result: Record<string, unknown>) => idEncode(parseInt(result['id'] as string), 'order'),
    loadMany: (req, ids) => req.loaders.Order.byId.loadMany(ids),
  },
  [ElasticSearchIndexName.TIERS]: {
    getGraphQLId: (result: Record<string, unknown>) => idEncode(parseInt(result['id'] as string), 'tier'),
    loadMany: (req, ids) => req.loaders.Tier.byId.loadMany(ids),
  },
  [ElasticSearchIndexName.TRANSACTIONS]: {
    getGraphQLId: (result: Record<string, unknown>) => result['uuid'] as string,
    loadMany: (req, ids) => req.loaders.Transaction.byId.loadMany(ids),
  },
  [ElasticSearchIndexName.UPDATES]: {
    getGraphQLId: (result: Record<string, unknown>) => idEncode(parseInt(result['id'] as string), 'update'),
    loadMany: (req, ids) => req.loaders.Update.byId.loadMany(ids),
  },
} as const;

/**
 * Creates a resolver for the given index that fetches the search results using the loader
 * generate by `generateSearchLoaders` in `server/graphql/loaders/search.ts`.
 *
 * The main benefit of this strategy is that we only search the indices that are actually fetched in the
 * original query.
 */
export const getElasticSearchIndexResolver = (
  req,
  index: keyof typeof GraphQLSearchResultsStrategy | `${keyof typeof GraphQLSearchResultsStrategy}`,
  baseSearchParams: {
    requestId: string;
    searchTerm: string;
    limit: number;
    account: Collective;
    host: Collective;
  },
) => {
  return async () => {
    const strategy = GraphQLSearchResultsStrategy[index];
    const results = (await req.loaders.search.load({ ...baseSearchParams, index })) as SearchResultBucket;
    if (!results || results['doc_count'] === 0) {
      return { collection: { totalCount: 0, offset: 0, limit: baseSearchParams.limit, nodes: () => [] } };
    }

    const hits = results['top_hits_by_index']['hits']['hits'];
    const getSQLIdFromHit = hit => hit['_source']['id'];
    const hitsGroupedBySQLId = groupBy(hits, getSQLIdFromHit);
    const hitsGroupedByGraphQLKey = mapKeys(hitsGroupedBySQLId, result => strategy.getGraphQLId(result[0]['_source']));
    const highlights = mapValues(hitsGroupedByGraphQLKey, hits => hits[0]['highlight']);
    return {
      highlights,
      collection: {
        totalCount: results['doc_count'],
        offset: 0,
        limit: baseSearchParams.limit,
        nodes: () => strategy.loadMany(req, hits.map(getSQLIdFromHit)),
      },
    };
  };
};
