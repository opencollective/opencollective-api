import debug from 'debug';

import { createRedisClient } from '../redis';

const makeRedisProvider = async ({ serverUrl }) => {
  const debugCache = debug('cache');

  const redisClient = await createRedisClient({ serverUrl, name: 'cache' });

  return {
    clear: async () => redisClient?.flushAll(),
    delete: async key => redisClient?.del(key),
    get: async (key, { unserialize = JSON.parse } = {}) => {
      const value = await redisClient?.get(key);
      if (value) {
        try {
          return unserialize(value);
        } catch (err) {
          debugCache(`Invalid JSON (${value}): ${err}`);
        }
      } else {
        return undefined;
      }
    },
    has: async key => {
      const value = await redisClient?.get(key);
      return value !== null;
    },
    set: async (key, value, expirationInSeconds, { serialize = JSON.stringify } = {}) => {
      if (value !== undefined) {
        if (expirationInSeconds) {
          return redisClient?.set(key, serialize(value), { EX: expirationInSeconds });
        } else {
          return redisClient?.set(key, serialize(value));
        }
      }
    },
  };
};

export default makeRedisProvider;
