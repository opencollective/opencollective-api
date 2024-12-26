import config from 'config';
import express from 'express';
import { GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';

import { isElasticSearchConfigured } from '../../../lib/elastic-search/client';
import { getElasticSearchQueryId } from '../../../lib/elastic-search/graphql-search';
import RateLimit from '../../../lib/rate-limit';
import { Forbidden, RateLimitExceeded } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLSearchResponse } from '../object/SearchResponse';

const getRateLimiter = (req: express.Request) => {
  if (req.remoteUser) {
    return new RateLimit(`search:user:${req.remoteUser.id}`, config.limits.search.global.perMinutePerUser, 60);
  } else {
    return new RateLimit(`search:ip:${req.ip}`, config.limits.search.global.perMinutePerIP, 60);
  }
};

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
    if (
      config.env === 'production' &&
      (!remoteUser || !remoteUser.collective?.settings?.earlyAccess?.['SEARCH_COMMAND'])
    ) {
      throw new Forbidden();
    } else if (!isElasticSearchConfigured()) {
      throw new Error(
        config.env === 'development' ? 'Elastic search is not running' : 'The search is temporarily unavailable',
      );
    }

    // Enforce rate limiting
    const rateLimiter = getRateLimiter(req);
    if (!(await rateLimiter.registerCall())) {
      throw new RateLimitExceeded();
    }

    // Parse arguments
    const host = args.host && (await fetchAccountWithReference(args.host));
    const account = args.account && (await fetchAccountWithReference(args.account));
    const limit = args.defaultLimit;

    // Return the base arguments that will be digested by `GraphQLSearchResponse`
    const requestId = getElasticSearchQueryId(remoteUser, host, account, searchTerm);
    return { results: { requestId, limit, searchTerm, account, host } };
  },
};

export default SearchQuery;
