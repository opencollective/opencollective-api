import config from 'config';
import express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';

import PlatformConstants from '../../../constants/platform';
import { assertCanSeeAllAccounts } from '../../../lib/private-accounts';
import RateLimit from '../../../lib/rate-limit';
import { getSearchProvider } from '../../../lib/search';
import { GraphQLSearchParams } from '../../../lib/search/graphql-search';
import { SearchProvider, SearchRequest } from '../../../lib/search/types';
import { User } from '../../../models';
import { Forbidden, RateLimitExceeded } from '../../errors';
import { GraphQLSearchBackend } from '../enum/SearchBackend';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLSearchResponse } from '../object/SearchResponse';

/**
 * Search is only available to admins of the platform accounts and of first-party hosts (OFICO members).
 */
const canAccessSearch = async (remoteUser: User | null): Promise<boolean> => {
  if (!remoteUser) {
    return false;
  }

  await remoteUser.populateRoles();
  const allowedCollectiveIds = [
    ...PlatformConstants.AllPlatformCollectiveIds,
    ...PlatformConstants.FirstPartyHostCollectiveIds,
  ];

  return remoteUser.getAdministratedCollectiveIds().some(id => allowedCollectiveIds.includes(id));
};

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
    if (config.env === 'production') {
      const earlyAccess = remoteUser?.collective?.settings?.earlyAccess;
      if (!earlyAccess?.['SEARCH_COMMAND'] || !(await canAccessSearch(remoteUser))) {
        throw new Forbidden();
      } else if (backend === SearchProvider.POSTGRES && !earlyAccess['SEARCH_POSTGRES_BACKEND']) {
        // The PostgreSQL backend is a team preview: it must be explicitly enabled (preview feature of the frontend)
        throw new Forbidden('The PostgreSQL search backend is only available to users who enabled its preview');
      }
    }

    const providerImplementation = getSearchProvider(backend);
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
      provider: backend,
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
