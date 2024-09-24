import config from 'config';
import express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLJSONObject } from 'graphql-scalars';

import { getElasticSearchClient } from '../../../lib/elastic-search/client';
import { getElasticSearchIndexResolver, getElasticSearchQueryId } from '../../../lib/elastic-search/graphql-search';
import { getSQLSearchResolver } from '../../../lib/sql-search';
import models from '../../../models';
import { GraphQLAccountCollection } from '../collection/AccountCollection';
import { CommentCollection } from '../collection/CommentCollection';
import { GraphQLExpenseCollection } from '../collection/ExpenseCollection';
import { GraphQLHostApplicationCollection } from '../collection/HostApplicationCollection';
import { GraphQLOrderCollection } from '../collection/OrderCollection';
import { GraphQLTierCollection } from '../collection/TierCollection';
import { GraphQLTransactionCollection } from '../collection/TransactionCollection';
import { GraphQLUpdateCollection } from '../collection/UpdateCollection';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';

const GraphQLSearchResponse = new GraphQLObjectType({
  name: 'SearchResponse',
  fields: {
    results: {
      type: new GraphQLNonNull(
        new GraphQLObjectType({
          name: 'SearchResults',
          fields: {
            accounts: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsAccounts',
                  fields: {
                    collection: { type: new GraphQLNonNull(GraphQLAccountCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
            comments: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsComments',
                  fields: {
                    collection: { type: new GraphQLNonNull(CommentCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
            expenses: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsExpenses',
                  fields: {
                    collection: { type: new GraphQLNonNull(GraphQLExpenseCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
            hostApplications: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsHostApplications',
                  fields: {
                    collection: { type: new GraphQLNonNull(GraphQLHostApplicationCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
            orders: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsOrders',
                  fields: {
                    collection: { type: new GraphQLNonNull(GraphQLOrderCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
            tiers: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsTiers',
                  fields: {
                    collection: { type: new GraphQLNonNull(GraphQLTierCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
            transactions: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsTransactions',
                  fields: {
                    collection: { type: new GraphQLNonNull(GraphQLTransactionCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
            updates: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsUpdates',
                  fields: {
                    collection: { type: new GraphQLNonNull(GraphQLUpdateCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
          },
        }),
      ),
    },
  },
});

const SearchQuery = {
  type: GraphQLSearchResponse,
  description: '[!] Warning: this query is currently in beta and the API might change',
  args: {
    searchTerm: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The search term to search for',
    },
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'Limit the scope of the search to this account and its children',
    },
    host: {
      type: GraphQLAccountReferenceInput,
      description: 'Limit the scope of the search to this host and its hosted accounts',
    },
    timeout: {
      type: new GraphQLNonNull(GraphQLInt),
      description:
        'The maximum amount of time in millisecond to wait for a single entity type query to complete (for SQL search)',
      defaultValue: 10_000,
    },
    defaultLimit: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'The default limit for each entity type',
      defaultValue: 10,
    },
    useElasticSearch: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether to use ElasticSearch or not',
      defaultValue: true,
    },
  },
  async resolve(_: void, { searchTerm, ...args }, req: express.Request) {
    const host = args.host && (await fetchAccountWithReference(args.host));
    const account = args.account && (await fetchAccountWithReference(args.account));
    const adminOfAccountIds = req.remoteUser?.getAdministratedCollectiveIds() ?? [];
    const limit = args.defaultLimit;

    // Fall back to Postgres in non-production environments if ElasticSearch is not configured
    const hasElasticSearch = Boolean(getElasticSearchClient());
    let useElasticSearch = hasElasticSearch && args.useElasticSearch;
    if (args.useElasticSearch && !hasElasticSearch && config.env !== 'production') {
      console.warn('ElasticSearch is not configured, falling back to Postgres');
      useElasticSearch = false;
    }

    // Elastic search
    if (useElasticSearch) {
      const requestId = getElasticSearchQueryId(req.remoteUser, host, account, searchTerm);
      const query = { requestId, limit, searchTerm, adminOfAccountIds, account, host };
      return {
        results: {
          accounts: getElasticSearchIndexResolver(req, 'collectives', query),
          comments: getElasticSearchIndexResolver(req, 'comments', query),
          expenses: getElasticSearchIndexResolver(req, 'expenses', query),
          hostApplications: getElasticSearchIndexResolver(req, 'host-applications', query),
          orders: getElasticSearchIndexResolver(req, 'orders', query),
          tiers: getElasticSearchIndexResolver(req, 'tiers', query),
          transactions: getElasticSearchIndexResolver(req, 'transactions', query),
          updates: getElasticSearchIndexResolver(req, 'updates', query),
        },
      };
    }
    // Fallback to Postgres
    else {
      // This is a fallback to Postgres as a search engine, it's not efficient and should be used only for dev/debugging.
      if (config.env === 'production' && !req.remoteUser?.isRoot()) {
        throw new Error('Searching without ElasticSearch is disabled in production');
      }

      const query = { searchTerm, limit, adminOfAccountIds, host, account, timeout: args.timeout };
      return {
        results: {
          accounts: getSQLSearchResolver(models.Collective, query),
          comments: getSQLSearchResolver(models.Comment, query),
          expenses: getSQLSearchResolver(models.Expense, query),
          hostApplications: getSQLSearchResolver(models.HostApplication, query),
          orders: getSQLSearchResolver(models.Order, query),
          tiers: getSQLSearchResolver(models.Tier, query),
          transactions: getSQLSearchResolver(models.Transaction, query),
          updates: getSQLSearchResolver(models.Update, query),
        },
      };
    }
  },
};

export default SearchQuery;
