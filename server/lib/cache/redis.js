import debug from 'debug';
import { createClient as createRedisClient } from 'redis';

import logger from '../logger';

const makeRedisProvider = async ({ serverUrl }) => {
  const debugCache = debug('cache');
  const redisOptions = { url: serverUrl };
  if (redisOptions.url.includes('rediss://')) {
    redisOptions.socket = { tls: true, rejectUnauthorized: false };
  }

  let redisClient = createRedisClient(redisOptions);
  try {
    await redisClient.connect();
  } catch (err) {
    logger.error('Redis cache connection error', err);
    redisClient = null;
  }

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
