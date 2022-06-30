import Promise from 'bluebird';
import debug from 'debug';
import redis from 'redis';

const asyncRedis = Promise.promisifyAll(redis);

const debugCache = debug('cache');

const makeRedisProvider = ({ serverUrl }) => {
  const redisOptions = {};
  if (serverUrl.includes('rediss://')) {
    redisOptions.tls = { rejectUnauthorized: false };
  }
  const client = asyncRedis.createClient(serverUrl, redisOptions);
  return {
    clear: async () => client.flushallAsync(),
    delete: async key => client.delAsync(key),
    get: async (key, { unserialize = JSON.parse } = {}) => {
      const value = await client.getAsync(key);
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
      const value = await client.getAsync(key);
      return value !== null;
    },
    set: async (key, value, expirationInSeconds, { serialize = JSON.stringify } = {}) => {
      if (value !== undefined) {
        if (expirationInSeconds) {
          return client.setexAsync(key, expirationInSeconds, serialize(value));
        } else {
          return client.setAsync(key, serialize(value));
        }
      }
    },
  };
};

export default makeRedisProvider;
