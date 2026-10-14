/**
 * This file binds the provider-independent search orchestration to the GraphQL API.
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
import { keyBy, mapValues } from 'lodash';

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

import { SearchEntity, SearchEntityParams, SearchHit, SearchRequest } from './types';

/**
 * The value returned by `Query.search`, consumed by the entity fields of `SearchResults`.
 */
export type GraphQLSearchParams = {
  request: SearchRequest;
  defaultLimit: number;
};

type GraphQLSearchIndexStrategy = {
  // A loader to use for loading entities from the (optionally encoded) ID
  loadMany: (req, ids) => Array<unknown | null>;
  // A function to encode the ID for use in the GraphQL API
  getGraphQLId: (hit: SearchHit) => string;
  // A function to get entity-specific parameters from the GraphQL arguments. By default, there are none.
  prepareArguments?: (args: Record<string, unknown>) => Record<string, unknown>;
  // Scopes to enforce to access private fields/entries
  oauthScopeForPrivateFields?: OAuthScopes;
  // Definition of the GraphQL arguments for the search query
  args?: GraphQLFieldConfigArgumentMap;
};

const GraphQLSearchResultsStrategy: Record<SearchEntity, GraphQLSearchIndexStrategy> = {
  [SearchEntity.ACCOUNTS]: {
    getGraphQLId: (hit: SearchHit) => idEncode(hit.id, 'account'),
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
    prepareArguments: (args: SearchQueryAccountsResolverArgs): SearchEntityParams[SearchEntity.ACCOUNTS] => {
      // Convert from GraphQL enum to SQL value (INDIVIDUAL -> USER)
      return { type: AccountTypeToModelMapping[args.type], isHost: args.isHost, tags: args.tags };
    },
  },
  [SearchEntity.COMMENTS]: {
    getGraphQLId: (hit: SearchHit) => idEncode(hit.id, 'comment'),
    loadMany: (req, ids) => req.loaders.Comment.byId.loadMany(ids),
  },
  [SearchEntity.EXPENSES]: {
    getGraphQLId: (hit: SearchHit) => idEncode(hit.id, 'expense'),
    loadMany: (req, ids) => req.loaders.Expense.byId.loadMany(ids),
    oauthScopeForPrivateFields: OAuthScopes.expenses,
  },
  [SearchEntity.HOST_APPLICATIONS]: {
    getGraphQLId: (hit: SearchHit) => idEncode(hit.id, 'host-application'),
    loadMany: (req, ids) => req.loaders.HostApplication.byId.loadMany(ids),
    oauthScopeForPrivateFields: OAuthScopes.applications,
  },
  [SearchEntity.ORDERS]: {
    getGraphQLId: (hit: SearchHit) => idEncode(hit.id, 'order'),
    loadMany: (req, ids) => req.loaders.Order.byId.loadMany(ids),
    oauthScopeForPrivateFields: OAuthScopes.orders,
  },
  [SearchEntity.TIERS]: {
    getGraphQLId: (hit: SearchHit) => idEncode(hit.id, 'tier'),
    loadMany: (req, ids) => req.loaders.Tier.byId.loadMany(ids),
  },
  [SearchEntity.TRANSACTIONS]: {
    getGraphQLId: (hit: SearchHit) => hit.uuid,
    loadMany: (req, ids) => req.loaders.Transaction.byId.loadMany(ids),
    oauthScopeForPrivateFields: OAuthScopes.transactions,
  },
  [SearchEntity.UPDATES]: {
    getGraphQLId: (hit: SearchHit) => idEncode(hit.id, 'update'),
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

const buildSearchResultsType = (entity: SearchEntity, name: string, collectionType: GraphQLObjectType) => {
  const strategy = GraphQLSearchResultsStrategy[entity];
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
    resolve: async ({ request, defaultLimit }: GraphQLSearchParams, args, req: express.Request) => {
      if (args.offset !== 0 && request.useTopHits) {
        throw new Error('Paginating with `offset` is not supported when `useTopHits` is true');
      }

      const limit = args.limit || defaultLimit;
      const offset = args.offset;
      const result = await req.loaders.search.load({
        request,
        entityRequest: {
          entity,
          params: strategy.prepareArguments ? strategy.prepareArguments(args) : {},
          forbidPrivate: getForbidPrivate(req, strategy),
          offset,
          limit,
        },
      });

      if (!result || result.totalCount === 0) {
        return {
          maxScore: 0,
          collection: { totalCount: 0, offset, limit, nodes: () => [] },
          highlights: {},
        };
      }

      const hitsGroupedByGraphQLKey = keyBy(result.hits, strategy.getGraphQLId);
      const highlights = mapValues(hitsGroupedByGraphQLKey, hit => ({
        score: hit.score,
        fields: hit.highlight,
      }));

      return {
        maxScore: result.maxScore,
        highlights,
        collection: {
          totalCount: result.totalCount,
          offset,
          limit,
          nodes: async () => {
            const entries = await strategy.loadMany(
              req,
              result.hits.map(hit => hit.id),
            );
            return entries.filter(Boolean); // Entries in the search index may have been deleted in the DB
          },
        },
      };
    },
  };
};

export const getSearchResultFields = () => {
  return {
    accounts: buildSearchResultsType(SearchEntity.ACCOUNTS, 'Accounts', GraphQLAccountCollection),
    comments: buildSearchResultsType(SearchEntity.COMMENTS, 'Comments', CommentCollection),
    expenses: buildSearchResultsType(SearchEntity.EXPENSES, 'Expenses', GraphQLExpenseCollection),
    hostApplications: buildSearchResultsType(
      SearchEntity.HOST_APPLICATIONS,
      'HostApplications',
      GraphQLHostApplicationCollection,
    ),
    orders: buildSearchResultsType(SearchEntity.ORDERS, 'Orders', GraphQLOrderCollection),
    tiers: buildSearchResultsType(SearchEntity.TIERS, 'Tiers', GraphQLTierCollection),
    transactions: buildSearchResultsType(SearchEntity.TRANSACTIONS, 'Transactions', GraphQLTransactionCollection),
    updates: buildSearchResultsType(SearchEntity.UPDATES, 'Updates', GraphQLUpdateCollection),
  };
};
