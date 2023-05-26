import debug from 'debug';
import { createClient } from 'redis';

const makeRedisProvider = async ({ serverUrl }) => {
  const debugCache = debug('cache');
  const redisOptions = {};
  if (serverUrl.includes('rediss://')) {
    redisOptions.tls = { rejectUnauthorized: false };
  }
  const client = createClient(serverUrl, redisOptions);
  await client.connect();
  return {
    clear: async () => client.flushall(),
    delete: async key => client.del(key),
    get: async (key, { unserialize = JSON.parse } = {}) => {
      const value = await client.get(key);
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
      const value = await client.get(key);
      return value !== null;
    },
    set: async (key, value, expirationInSeconds, { serialize = JSON.stringify } = {}) => {
      if (value !== undefined) {
        if (expirationInSeconds) {
          return client.setex(key, expirationInSeconds, serialize(value));
        } else {
          return client.set(key, serialize(value));
        }
      }
    },
  };
};

export default makeRedisProvider;
