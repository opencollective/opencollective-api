/**
 * This file contains the logic to bind the OpenSearch functionality to the GraphQL API.
 */

import express from 'express';
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

import OAuthScopes from '../../constants/oauth-scopes';
import { checkScope } from '../../graphql/common/scope-check';
import { FieldsToGraphQLFieldConfigArgumentMap } from '../../graphql/common/typescript-helpers';
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
import { getCollectionArgs } from '../../graphql/v2/interface/Collection';
import type { SearchQueryAccountsResolverArgs } from '../../graphql/v2/object/SearchResponse';
import { Collective, User } from '../../models';

import { OpenSearchIndexName, OpenSearchIndexParams } from './constants';

export type GraphQLSearchParams = {
  requestId: string;
  searchTerm: string;
  defaultLimit: number;
  account: Collective;
  host: Collective;
  useTopHits: boolean;
};

/**
 * Returns a unique identifier for the OpenSearch query, which can be used to batch multiple queries together.
 */
export const getOpenSearchQueryId = (
  user: User | null,
  host: Collective,
  account: Collective,
  searchTerm: string,
  useTopHits: boolean,
) => {
  return `${user?.id || 'public'}-host_${host?.id || 'all'}-account_${account?.id || 'all'}-${searchTerm}-${useTopHits ? 'top_hits' : 'separated_hits'}`;
};

type GraphQLSearchIndexStrategy = {
  // A loader to use for loading entities from the (optionally encoded) ID
  loadMany: (req, ids) => Array<unknown | null>;
  // A function to encode the ID for use in the GraphQL API
  getGraphQLId: (result: Record<string, unknown>) => string;
  // A function to get index-specific parameters from the GraphQL arguments. By default, it returns the raw arguments.
  prepareArguments?: (args: Record<string, unknown>) => Record<string, unknown>;
  // Scopes to enforce to access private fields/entries
  oauthScopeForPrivateFields?: OAuthScopes;
  // Definition of the GraphQL arguments for the search query
  args?: GraphQLFieldConfigArgumentMap;
};

const GraphQLSearchResultsStrategy: Record<OpenSearchIndexName, GraphQLSearchIndexStrategy> = {
  [OpenSearchIndexName.COLLECTIVES]: {
    getGraphQLId: (result: Record<string, unknown>) => idEncode(parseInt(result['id'] as string), 'account'),
    loadMany: (req, ids) => req.loaders.Collective.byId.loadMany(ids),
    oauthScopeForPrivateFields: OAuthScopes.account,
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
    ): OpenSearchIndexParams[OpenSearchIndexName.COLLECTIVES] => {
      // Convert from GraphQL enum to SQL value (INDIVIDUAL -> USER)
      return { ...args, type: AccountTypeToModelMapping[args.type] };
    },
  },
  [OpenSearchIndexName.COMMENTS]: {
    getGraphQLId: (result: Record<string, unknown>) => idEncode(parseInt(result['id'] as string), 'comment'),
    loadMany: (req, ids) => req.loaders.Comment.byId.loadMany(ids),
  },
  [OpenSearchIndexName.EXPENSES]: {
    getGraphQLId: (result: Record<string, unknown>) => idEncode(parseInt(result['id'] as string), 'expense'),
    loadMany: (req, ids) => req.loaders.Expense.byId.loadMany(ids),
    oauthScopeForPrivateFields: OAuthScopes.expenses,
  },
  [OpenSearchIndexName.HOST_APPLICATIONS]: {
    getGraphQLId: (result: Record<string, unknown>) => idEncode(parseInt(result['id'] as string), 'host-application'),
    loadMany: (req, ids) => req.loaders.HostApplication.byId.loadMany(ids),
    oauthScopeForPrivateFields: OAuthScopes.applications,
  },
  [OpenSearchIndexName.ORDERS]: {
    getGraphQLId: (result: Record<string, unknown>) => idEncode(parseInt(result['id'] as string), 'order'),
    loadMany: (req, ids) => req.loaders.Order.byId.loadMany(ids),
    oauthScopeForPrivateFields: OAuthScopes.orders,
  },
  [OpenSearchIndexName.TIERS]: {
    getGraphQLId: (result: Record<string, unknown>) => idEncode(parseInt(result['id'] as string), 'tier'),
    loadMany: (req, ids) => req.loaders.Tier.byId.loadMany(ids),
  },
  [OpenSearchIndexName.TRANSACTIONS]: {
    getGraphQLId: (result: Record<string, unknown>) => result['uuid'] as string,
    loadMany: (req, ids) => req.loaders.Transaction.byId.loadMany(ids),
    oauthScopeForPrivateFields: OAuthScopes.transactions,
  },
  [OpenSearchIndexName.UPDATES]: {
    getGraphQLId: (result: Record<string, unknown>) => idEncode(parseInt(result['id'] as string), 'update'),
    loadMany: (req, ids) => req.loaders.Update.byId.loadMany(ids),
    oauthScopeForPrivateFields: OAuthScopes.updates,
  },
} as const;

const getForbidPrivate = (req, strategy: GraphQLSearchIndexStrategy) => {
  if (!req.remoteUser) {
    return true;
  } else if (strategy.oauthScopeForPrivateFields) {
    return !checkScope(req, strategy.oauthScopeForPrivateFields);
  } else {
    return false;
  }
};

const buildSearchResultsType = (index: OpenSearchIndexName, name: string, collectionType: GraphQLObjectType) => {
  const strategy = GraphQLSearchResultsStrategy[index];
  return {
    description: `Search results for ${name}`,
    args: {
      ...getCollectionArgs({ offset: 0, limit: 0 }),
      ...strategy.args,
    },
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
    resolve: async (baseSearchParams: GraphQLSearchParams, args, req: express.Request) => {
      if (args.offset !== 0 && baseSearchParams.useTopHits) {
        throw new Error('Paginating with `offset` is not supported when `useTopHits` is true');
      }

      const limit = args.limit || baseSearchParams.defaultLimit;
      const offset = args.offset;
      const result = await req.loaders.search.load({
        ...baseSearchParams,
        index,
        useTopHits: baseSearchParams.useTopHits,
        indexParams: strategy.prepareArguments ? strategy.prepareArguments(args) : args,
        forbidPrivate: getForbidPrivate(req, strategy),
        offset,
        limit,
      });

      if (!result || result.count === 0) {
        return {
          maxScore: 0,
          collection: { totalCount: 0, offset, limit, nodes: () => [] },
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
          offset,
          limit,
          nodes: async () => {
            const entries = await strategy.loadMany(req, result.hits.map(getSQLIdFromHit));
            return entries.filter(Boolean); // Entries in OpenSearch may have been deleted in the DB
          },
        },
      };
    },
  };
};

export const getSearchResultFields = () => {
  return {
    accounts: buildSearchResultsType(OpenSearchIndexName.COLLECTIVES, 'Accounts', GraphQLAccountCollection),
    comments: buildSearchResultsType(OpenSearchIndexName.COMMENTS, 'Comments', CommentCollection),
    expenses: buildSearchResultsType(OpenSearchIndexName.EXPENSES, 'Expenses', GraphQLExpenseCollection),
    hostApplications: buildSearchResultsType(
      OpenSearchIndexName.HOST_APPLICATIONS,
      'HostApplications',
      GraphQLHostApplicationCollection,
    ),
    orders: buildSearchResultsType(OpenSearchIndexName.ORDERS, 'Orders', GraphQLOrderCollection),
    tiers: buildSearchResultsType(OpenSearchIndexName.TIERS, 'Tiers', GraphQLTierCollection),
    transactions: buildSearchResultsType(
      OpenSearchIndexName.TRANSACTIONS,
      'Transactions',
      GraphQLTransactionCollection,
    ),
    updates: buildSearchResultsType(OpenSearchIndexName.UPDATES, 'Updates', GraphQLUpdateCollection),
  };
};
