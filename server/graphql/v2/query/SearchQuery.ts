import config from 'config';
import express from 'express';
import { GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';

import { getElasticSearchClient } from '../../../lib/elastic-search/client';
import { getElasticSearchQueryId } from '../../../lib/elastic-search/graphql-search';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLSearchResponse } from '../object/SearchResponse';

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
  },
  async resolve(_: void, { searchTerm, ...args }, req: express.Request) {
    const { remoteUser } = req;
    if (config.env === 'production' && !remoteUser?.isRoot()) {
      throw new Error('This query is only available to root users in production');
    }

    const host = args.host && (await fetchAccountWithReference(args.host));
    const account = args.account && (await fetchAccountWithReference(args.account));
    const limit = args.defaultLimit;

    if (!getElasticSearchClient()) {
      throw new Error(
        config.env === 'development' ? 'Elastic search is not running' : 'The search is temporarily unavailable',
      );
    }

    const requestId = getElasticSearchQueryId(remoteUser, host, account, searchTerm);
    return { results: { requestId, limit, searchTerm, account, host } }; // Will be digested by `GraphQLSearchResponse`
  },
};

export default SearchQuery;
