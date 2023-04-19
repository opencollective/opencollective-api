import { LRUCache } from 'lru-cache';

const makeMemoryProvider = opts => {
  const cache = new LRUCache(opts);
  return {
    clear: async () => cache.reset(),
    delete: async key => cache.delete(key),
    get: async key => cache.get(key),
    has: async key => cache.has(key),
    set: async (key, value, expirationInSeconds) => cache.set(key, value, { ttl: expirationInSeconds * 1000 }),
  };
};

export default makeMemoryProvider;
