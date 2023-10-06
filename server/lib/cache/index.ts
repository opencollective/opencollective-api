import config from 'config';
import debug from 'debug';
import { get } from 'lodash';

import models from '../../models';
import { purgeCacheForPage } from '../cloudflare';
import { invalidateContributorsCache } from '../contributors';
import logger from '../logger';
import { md5 } from '../utils';

import makeMemoryProvider from './memory';
import makeRedisProvider from './redis';

export const PROVIDER_TYPES = {
  MEMORY: 'MEMORY',
  REDIS: 'REDIS',
};

const debugCache = debug('cache');

const oneDayInSeconds = 60 * 60 * 24;

export const getProvider = async providerType => {
  switch (providerType) {
    case PROVIDER_TYPES.REDIS:
      return makeRedisProvider();
    case PROVIDER_TYPES.MEMORY:
      return makeMemoryProvider({ max: 1000 });
    default:
      throw new Error(`Unsupported cache provider: ${providerType}`);
  }
};

const getDefaultProviderType = () => {
  if (get(config, 'redis.serverUrl')) {
    return PROVIDER_TYPES.REDIS;
  } else {
    return PROVIDER_TYPES.MEMORY;
  }
};

let defaultProvider;

const getDefaultProvider = (): Promise<ReturnType<typeof getProvider>> => {
  const defaultProviderType = getDefaultProviderType();
  if (!defaultProvider) {
    defaultProvider = getProvider(defaultProviderType);
  }
  return defaultProvider;
};

const cache = {
  clear: async () => {
    try {
      debugCache('clear');
      const provider = await getDefaultProvider();
      return provider.clear();
    } catch (err) {
      logger.warn(`Error while clearing cache: ${err.message}`);
    }
  },
  delete: async (key: string) => {
    try {
      debugCache(`delete ${key}`);
      const provider = await getDefaultProvider();
      return provider.delete(key);
    } catch (err) {
      logger.warn(`Error while deleting from cache: ${err.message}`);
    }
  },
  get: async (key: string, options?) => {
    try {
      debugCache(`get ${key}`);
      const provider = await getDefaultProvider();
      return provider.get(key, options);
    } catch (err) {
      logger.warn(`Error while fetching from cache: ${err.message}`);
    }
  },
  has: async (key: string) => {
    try {
      debugCache(`has ${key}`);
      const provider = await getDefaultProvider();
      return provider.has(key);
    } catch (err) {
      logger.warn(`Error while checking from cache: ${err.message}`);
    }
  },
  set: async (key: string, value: any, expirationInSeconds?: number, options?) => {
    try {
      debugCache(`set ${key}`);
      const provider = await getDefaultProvider();
      return provider.set(key, value, expirationInSeconds, options);
    } catch (err) {
      logger.warn(`Error while writing to cache: ${err.message}`);
    }
  },
};

export async function fetchCollectiveId(collectiveSlug) {
  const cacheKey = `collective_id_with_slug_${collectiveSlug}`;
  const collectiveId = await cache.get(cacheKey);
  if (collectiveId) {
    return collectiveId;
  }
  const collective = await models.Collective.findOne({
    attributes: ['id'],
    where: { slug: collectiveSlug.toLowerCase() },
  });
  if (collective) {
    cache.set(cacheKey, collective.id, oneDayInSeconds);
    return collective.id;
  }
}

export function memoize(func, { key, maxAge = 0, serialize, unserialize }) {
  const cacheKey = args => {
    return args.length ? `${key}_${md5(JSON.stringify(args))}` : key;
  };

  const memoizedFunction = async function (...args) {
    let value = await cache.get(cacheKey(args), { unserialize });
    if (value === undefined) {
      value = await func(...args);
      cache.set(cacheKey(args), value, maxAge, { serialize });
    }
    return value;
  };

  memoizedFunction.refresh = async function (...args) {
    const value = await func(...args);
    cache.set(cacheKey(args), value, maxAge, { serialize });
  };

  memoizedFunction.clear = async function (...args) {
    cache.delete(cacheKey(args));
  };

  return memoizedFunction;
}

export async function purgeGraphqlCacheForCollective(slug) {
  return cache.get(`graphqlCacheKeys_${slug}`).then(keys => {
    if (keys) {
      cache.delete(`graphqlCacheKeys_${slug}`);
      for (const key of keys) {
        cache.delete(key);
      }
    }
  });
}

export function purgeCacheForCollective(slug) {
  purgeCacheForPage(`/${slug}`);
  purgeGraphqlCacheForCollective(slug);
}

/**
 * purgeCacheForCollective + purge contributors cache
 */
export async function purgeAllCachesForAccount(account) {
  purgeCacheForCollective(account.slug);
  await invalidateContributorsCache(account.id);
}

export default cache;
