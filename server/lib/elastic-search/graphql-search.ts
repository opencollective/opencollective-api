/**
 * This file contains the logic to bind the ElasticSearch functionality to the GraphQL API.
 */

import {
  GraphQLBoolean,
  GraphQLFieldConfigArgumentMap,
  GraphQLFloat,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { GraphQLJSONObject } from 'graphql-scalars';
import { keyBy, mapKeys, mapValues } from 'lodash';

import { FieldsToGraphQLFieldConfigArgumentMap } from '../../graphql/common/typescript-helpers';
import { SearchResult } from '../../graphql/loaders/search';
import { GraphQLAccountCollection } from '../../graphql/v2/collection/AccountCollection';
import { CommentCollection } from '../../graphql/v2/collection/CommentCollection';
import { GraphQLExpenseCollection } from '../../graphql/v2/collection/ExpenseCollection';
import { GraphQLHostApplicationCollection } from '../../graphql/v2/collection/HostApplicationCollection';
import { GraphQLOrderCollection } from '../../graphql/v2/collection/OrderCollection';
import { GraphQLTierCollection } from '../../graphql/v2/collection/TierCollection';
import { GraphQLTransactionCollection } from '../../graphql/v2/collection/TransactionCollection';
import { GraphQLUpdateCollection } from '../../graphql/v2/collection/UpdateCollection';
import { AccountTypeToModelMapping, GraphQLAccountType } from '../../graphql/v2/enum';
import { idEncode } from '../../graphql/v2/identifiers';
import type { SearchQueryAccountsResolverArgs } from '../../graphql/v2/object/SearchResponse';
import { Collective, User } from '../../models';

import { ElasticSearchIndexName, ElasticSearchIndexParams } from './constants';

type GraphQLSearchParams = {
  requestId: string;
  searchTerm: string;
  limit: number;
  account: Collective;
  host: Collective;
};

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
    loadMany: (req, ids) => Array<unknown | null>;
    // A function to encode the ID for use in the GraphQL API
    getGraphQLId: (result: Record<string, unknown>) => string;
    // A function to get Elastic Search index-specific parameters from the GraphQL arguments. By default, it returns the raw arguments.
    prepareArguments?: (args: Record<string, unknown>) => Record<string, unknown>;
    // Definition of the GraphQL arguments for the search query
    args?: GraphQLFieldConfigArgumentMap;
  }
> = {
  [ElasticSearchIndexName.COLLECTIVES]: {
    getGraphQLId: (result: Record<string, unknown>) => idEncode(parseInt(result['id'] as string), 'account'),
    loadMany: (req, ids) => req.loaders.Collective.byId.loadMany(ids),
    args: {
      type: {
        type: GraphQLAccountType,
        description: 'Type of account',
      },
      isHost: {
        type: GraphQLBoolean,
        description: 'Whether the account is a host or not',
      },
      tags: {
        type: new GraphQLList(GraphQLString),
        description: 'Tags to filter the accounts',
      },
    } satisfies FieldsToGraphQLFieldConfigArgumentMap<SearchQueryAccountsResolverArgs>,
    prepareArguments: (
      args: SearchQueryAccountsResolverArgs,
    ): ElasticSearchIndexParams[ElasticSearchIndexName.COLLECTIVES] => {
      // Convert from GraphQL enum to SQL value (INDIVIDUAL -> USER)
      return { ...args, type: AccountTypeToModelMapping[args.type] };
    },
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

const buildSearchResultsType = (index: ElasticSearchIndexName, name: string, collectionType: GraphQLObjectType) => {
  const strategy = GraphQLSearchResultsStrategy[index];
  return {
    description: `Search results for ${name}`,
    args: strategy.args,
    type: new GraphQLObjectType({
      name: `SearchResults${name}`,
      fields: {
        collection: { type: new GraphQLNonNull(collectionType) },
        maxScore: { type: new GraphQLNonNull(GraphQLFloat) },
        highlights: {
          type: GraphQLJSONObject,
          description:
            'Details about the matches typed as: { [id]: { score: number, fields: { [field]: [highlight] } } }',
        },
      },
    }),
    resolve: async (baseSearchParams: GraphQLSearchParams, args, req) => {
      const indexParams = strategy.prepareArguments ? strategy.prepareArguments(args) : args;
      const fullSearchParams = { ...baseSearchParams, index, indexParams };
      const result = (await req.loaders.search.load(fullSearchParams)) as SearchResult | null;

      if (!result || result.count === 0) {
        return {
          maxScore: 0,
          collection: { totalCount: 0, offset: 0, limit: baseSearchParams.limit, nodes: () => [] },
          highlights: {},
        };
      }

      const getSQLIdFromHit = (hit: (typeof result.hits)[0]): number => hit.source['id'] as number;
      const hitsGroupedBySQLId = keyBy(result.hits, getSQLIdFromHit);
      const hitsGroupedByGraphQLKey = mapKeys(hitsGroupedBySQLId, result => strategy.getGraphQLId(result.source));
      const highlights = mapValues(hitsGroupedByGraphQLKey, hit => ({
        score: hit.score,
        fields: hit.highlight,
      }));

      return {
        maxScore: result.maxScore,
        highlights,
        collection: {
          totalCount: result.count,
          offset: 0,
          limit: baseSearchParams.limit,
          nodes: async () => {
            const entries = await strategy.loadMany(req, result.hits.map(getSQLIdFromHit));
            return entries.filter(Boolean); // Entries in ElasticSearch may have been deleted in the DB
          },
        },
      };
    },
  };
};

export const getSearchResultFields = () => {
  return {
    accounts: buildSearchResultsType(ElasticSearchIndexName.COLLECTIVES, 'Accounts', GraphQLAccountCollection),
    comments: buildSearchResultsType(ElasticSearchIndexName.COMMENTS, 'Comments', CommentCollection),
    expenses: buildSearchResultsType(ElasticSearchIndexName.EXPENSES, 'Expenses', GraphQLExpenseCollection),
    hostApplications: buildSearchResultsType(
      ElasticSearchIndexName.HOST_APPLICATIONS,
      'HostApplications',
      GraphQLHostApplicationCollection,
    ),
    orders: buildSearchResultsType(ElasticSearchIndexName.ORDERS, 'Orders', GraphQLOrderCollection),
    tiers: buildSearchResultsType(ElasticSearchIndexName.TIERS, 'Tiers', GraphQLTierCollection),
    transactions: buildSearchResultsType(
      ElasticSearchIndexName.TRANSACTIONS,
      'Transactions',
      GraphQLTransactionCollection,
    ),
    updates: buildSearchResultsType(ElasticSearchIndexName.UPDATES, 'Updates', GraphQLUpdateCollection),
  };
};
