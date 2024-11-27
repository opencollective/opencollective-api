import config from 'config';
import express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';

import { getElasticSearchClient } from '../../../lib/elastic-search/client';
import { getElasticSearchIndexResolver, getElasticSearchQueryId } from '../../../lib/elastic-search/graphql-search';
import logger from '../../../lib/logger';
import { getSQLSearchResolver } from '../../../lib/sql-search';
import models from '../../../models';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLSearchResponse } from '../object/SearchReponse';

const SearchQuery = {
  type: new GraphQLNonNull(GraphQLSearchResponse),
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
    const { remoteUser } = req;
    if (config.env === 'production' && !remoteUser?.isRoot()) {
      throw new Error('This query is only available to root users in production');
    }

    const host = args.host && (await fetchAccountWithReference(args.host));
    const account = args.account && (await fetchAccountWithReference(args.account));
    const limit = args.defaultLimit;

    // Fall back to Postgres in non-production environments if ElasticSearch is not configured
    const hasElasticSearch = Boolean(getElasticSearchClient());
    let useElasticSearch = hasElasticSearch && args.useElasticSearch;
    if (args.useElasticSearch && !hasElasticSearch && config.env !== 'production') {
      logger.warn('ElasticSearch is not configured, falling back to Postgres');
      useElasticSearch = false;
    }

    // Elastic search
    if (useElasticSearch) {
      const requestId = getElasticSearchQueryId(remoteUser, host, account, searchTerm);
      const query = { requestId, limit, searchTerm, account, host };
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
    // This falls back to Postgres as a search engine, which is not efficient and should be used only for dev/debugging.
    else {
      const query = { searchTerm, limit, remoteUser, host, account, timeout: args.timeout };
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
