import { LRUCache } from 'lru-cache';

const makeMemoryProvider = opts => {
  const cache = new LRUCache<string, unknown>(opts);
  return {
    clear: async () => cache.clear(),
    delete: async (key: string | string[]) => {
      if (Array.isArray(key)) {
        let i = 0;
        for (const k of key) {
          const deleted = cache.delete(k);
          if (deleted) {
            i++;
          }
        }
        return i;
      } else {
        const deleted = cache.delete(key);
        return deleted ? 1 : 0;
      }
    },
    get: async key => cache.get(key),
    has: async key => cache.has(key),
    set: async (key, value, expirationInSeconds) => cache.set(key, value, { ttl: expirationInSeconds * 1000 }),
    keys: async pattern => {
      const k: string[] = [];
      const reg = new RegExp(`^${pattern.replace(/\*/g, '.*')}`);
      for (const key of cache.keys()) {
        if (reg.test(key)) {
          k.push(key);
        }
      }
      return k;
    },
    /** Atomically return the value if present and remove the key (no await between checks - safe vs concurrent callers). */
    consume: async (key: string, options?: unknown) => {
      void options;
      if (!cache.has(key)) {
        return undefined;
      }
      const value = cache.get(key);
      cache.delete(key);
      return value;
    },
  };
};

export default makeMemoryProvider;
