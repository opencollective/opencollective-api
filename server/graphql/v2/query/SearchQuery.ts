import config from 'config';
import express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';

import { assertCanSeeAllAccounts } from '../../../lib/private-accounts';
import RateLimit from '../../../lib/rate-limit';
import { getSearchProvider } from '../../../lib/search';
import { GraphQLSearchParams } from '../../../lib/search/graphql-search';
import { SearchProvider, SearchRequest } from '../../../lib/search/types';
import { Forbidden, RateLimitExceeded } from '../../errors';
import { GraphQLSearchBackend } from '../enum/SearchBackend';
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
    backend: {
      type: new GraphQLNonNull(GraphQLSearchBackend),
      description: 'The backend to use for this search',
      defaultValue: SearchProvider.OPENSEARCH,
    },
    account: {
      type: GraphQLAccountReferenceInput,
      description:
        'Limit the scope of the search to this account and its children. When used with `host`, results must match both.',
    },
    host: {
      type: GraphQLAccountReferenceInput,
      description:
        'Limit the scope of the search to this host and its hosted accounts. When used with `account`, results must match both.',
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
  },
  async resolve(
    _: void,
    { searchTerm, useTopHits, backend, ...args },
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
    }

    const provider: SearchProvider = backend;
    const providerImplementation = getSearchProvider(provider);
    providerImplementation.assertAvailable();

    // Enforce rate limiting
    const rateLimiter = getRateLimiter(req);
    if (!(await rateLimiter.registerCall())) {
      throw new RateLimitExceeded();
    }

    // Parse arguments
    const host = args.host && (await fetchAccountWithReference(args.host));
    const account = args.account && (await fetchAccountWithReference(args.account));
    if (account || host) {
      await assertCanSeeAllAccounts(req, [account, host].filter(Boolean));
    }

    // Return the base arguments that will be digested by `GraphQLSearchResponse`
    const request: SearchRequest = {
      provider,
      term: searchTerm,
      scope: { account: account || null, host: host || null },
      remoteUser: remoteUser || null,
      timeoutInMs: args.timeout,
      useTopHits,
    };

    providerImplementation.validateRequest?.(request);
    return { results: { defaultLimit: args.defaultLimit, request } };
  },
};

export default SearchQuery;
