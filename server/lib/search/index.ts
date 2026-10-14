/**
 * Search orchestration: dispatches provider-independent search requests to the selected provider.
 */

import { isNil, omitBy } from 'lodash';

import { OpenSearchProvider } from './providers/opensearch';
import { PostgresProvider } from './providers/postgres';
import { SearchEntityRequest, SearchProvider, SearchProviderImplementation, SearchRequest } from './types';

const SearchProviders: Record<SearchProvider, SearchProviderImplementation> = {
  [SearchProvider.OPENSEARCH]: OpenSearchProvider,
  [SearchProvider.POSTGRES]: PostgresProvider,
};

export const getSearchProvider = (provider: SearchProvider): SearchProviderImplementation => {
  const implementation = SearchProviders[provider];
  if (!implementation) {
    throw new Error(`Unsupported search provider: ${provider}`);
  }

  return implementation;
};

/**
 * JSON serialization with sorted object keys, ignoring `null`/`undefined` values.
 */
const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(omitBy(value, isNil)).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
  } else {
    return JSON.stringify(value ?? null);
  }
};

/**
 * A request-local key that identifies every argument shared by the entities of a search. Entity requests with the
 * same search key can be executed together by the provider.
 */
export const getSearchRequestKey = (request: SearchRequest): string => {
  return stableStringify({
    provider: request.provider,
    term: request.term,
    accountId: request.scope.account?.id,
    hostId: request.scope.host?.id,
    userId: request.remoteUser?.id,
    timeoutInMs: request.timeoutInMs,
    useTopHits: request.useTopHits,
  });
};

/**
 * A request-local key that identifies every argument that can affect the results of an entity search.
 */
export const getSearchEntityRequestKey = (request: SearchRequest, entityRequest: SearchEntityRequest): string => {
  return `${getSearchRequestKey(request)}|${stableStringify({
    entity: entityRequest.entity,
    params: entityRequest.params,
    forbidPrivate: entityRequest.forbidPrivate,
    limit: entityRequest.limit,
    offset: entityRequest.offset,
  })}`;
};
