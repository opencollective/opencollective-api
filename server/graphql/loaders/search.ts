import config from 'config';
import DataLoader from 'dataloader';
import { groupBy } from 'lodash';

import { getSearchEntityRequestKey, getSearchProvider, getSearchRequestKey } from '../../lib/search';
import { SearchEntityRequest, SearchEntityResult, SearchRequest } from '../../lib/search/types';

type SearchLoaderKey = {
  request: SearchRequest;
  entityRequest: SearchEntityRequest;
};

/**
 * A request-local loader that batches the entity searches requested in the same tick. Requests are cached by a key
 * that covers every result-affecting argument (provider, term, scope, access, timeout, entity filters and
 * pagination), so aliases and pages never share results unless all their arguments are identical. Entity requests
 * that share the same search arguments are dispatched together to the provider.
 */
export const generateSearchLoaders = () => {
  return new DataLoader<SearchLoaderKey, SearchEntityResult | null, string>(
    async (keys: readonly SearchLoaderKey[]) => {
      if (keys.length > parseInt(config.limits.search.concurrentRequests)) {
        throw new Error('Too many concurrent search requests');
      }

      const results = new Map<SearchLoaderKey, SearchEntityResult | null | Error>();
      const keysBySearch = groupBy(keys, key => getSearchRequestKey(key.request));
      for (const searchKeys of Object.values(keysBySearch)) {
        const { request } = searchKeys[0];
        const provider = getSearchProvider(request.provider);
        try {
          const searchResults = await provider.search(
            request,
            searchKeys.map(key => key.entityRequest),
          );

          searchKeys.forEach((key, idx) => results.set(key, searchResults[idx] ?? null));
        } catch (error) {
          // A failing search must not fail the other searches (aliases, providers) of the same batch
          searchKeys.forEach(key => results.set(key, error));
        }
      }

      return keys.map(key => results.get(key) ?? null);
    },
    { cacheKeyFn: ({ request, entityRequest }) => getSearchEntityRequestKey(request, entityRequest) },
  );
};
