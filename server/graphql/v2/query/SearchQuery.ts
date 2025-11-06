import config from 'config';
import express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';
import { v7 as uuidV7 } from 'uuid';

import { isOpenSearchConfigured } from '../../../lib/open-search/client';
import { getOpenSearchQueryId, GraphQLSearchParams } from '../../../lib/open-search/graphql-search';
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
    useTopHits: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description:
        'Set this to true if you are displaying all the results in the same list, and want a consistent sorting order across different types. (!) Paginating wih `offset` will not be supported',
      defaultValue: false,
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
    usePersonalization: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether to filter results based on user context (user ID and administrated collective IDs)',
      defaultValue: true,
    },
  },
  async resolve(
    _: void,
    { searchTerm, useTopHits, usePersonalization, ...args },
    req: express.Request,
  ): Promise<{
    results: GraphQLSearchParams;
  }> {
    const { remoteUser } = req;
    if (
      config.env === 'production' &&
      (!remoteUser || !remoteUser.collective?.settings?.earlyAccess?.['SEARCH_COMMAND'])
    ) {
      throw new Forbidden();
    } else if (!isOpenSearchConfigured()) {
      throw new Error(
        config.env === 'development' ? 'OpenSearch is not running' : 'The search is temporarily unavailable',
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
    const defaultLimit = args.defaultLimit;

    // Return the base arguments that will be digested by `GraphQLSearchResponse`
    const resolverId = uuidV7(); // To distinguish in case multiple search queries are made with aliases
    const requestId = `${resolverId}-${getOpenSearchQueryId(remoteUser, host, account, searchTerm, useTopHits, usePersonalization)}`;
    return { results: { requestId, defaultLimit, searchTerm, account, host, useTopHits, usePersonalization } };
  },
};

export default SearchQuery;
