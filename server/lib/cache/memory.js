import LRU from 'lru-cache';

const makeMemoryProvider = opts => {
  const lruCache = new LRU(opts);
  return {
    clear: async () => lruCache.reset(),
    del: async keys => {
      if (Array.isArray(keys)) {
        keys.forEach(key => lruCache.del(key));
      } else {
        lruCache.del(keys);
      }
    },
    get: async key => lruCache.get(key),
    has: async key => lruCache.has(key),
    set: async (key, value, expirationInSeconds) => lruCache.set(key, value, expirationInSeconds * 1000),
    keys: async pattern => {
      const r = new RegExp(pattern.replace('*', '.*'));
      const keys = lruCache.keys().filter(k => r.test(k));
      return keys;
    },
  };
};

export default makeMemoryProvider;
