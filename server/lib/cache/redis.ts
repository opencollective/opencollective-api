import debug from 'debug';

import { createRedisClient, RedisInstanceType } from '../redis';

/**
 * Increments a counter and returns its new value. The expiry is only set when the key has none, so it runs from the
 * first increment (fixed window), and a key can never be left without one. A single script, so concurrent increments
 * can't be lost.
 */
const INCREMENT_SCRIPT = `
  local count = redis.call('INCRBY', KEYS[1], ARGV[1])
  if redis.call('TTL', KEYS[1]) == -1 then
    redis.call('EXPIRE', KEYS[1], ARGV[2])
  end
  return count
`;

/**
 * Decrements a counter, only if it still exists (so an expired window is never recreated) and never below zero. The
 * key keeps its expiry. Returns the new value, or 0 if the key doesn't exist.
 */
const DECREMENT_SCRIPT = `
  if redis.call('EXISTS', KEYS[1]) == 0 then
    return 0
  end
  local count = redis.call('DECRBY', KEYS[1], ARGV[1])
  if count < 0 then
    count = redis.call('INCRBY', KEYS[1], -count)
  end
  return count
`;

const makeRedisProvider = async (instanceType = RedisInstanceType.DEFAULT) => {
  const debugCache = debug('cache');

  const redisClient = await createRedisClient(instanceType);

  return {
    clear: async () => redisClient?.flushAll(),
    delete: async (key: string | string[]) => redisClient?.del(key),
    get: async (key, { unserialize = JSON.parse } = {}) => {
      const value = (await redisClient?.get(key)) as string;
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
    keys: async pattern => {
      const keys = await redisClient?.keys(pattern);
      return keys || [];
    },
    increment: async (key: string, amount: number, expirationInSeconds: number): Promise<number | undefined> => {
      if (redisClient) {
        const args = [String(amount), String(expirationInSeconds)];
        return Number(await redisClient.eval(INCREMENT_SCRIPT, { keys: [key], arguments: args }));
      }
    },
    decrement: async (key: string, amount: number): Promise<number | undefined> => {
      if (redisClient) {
        return Number(await redisClient.eval(DECREMENT_SCRIPT, { keys: [key], arguments: [String(amount)] }));
      }
    },
    consume: async (key: string | string[], { unserialize = JSON.parse } = {}) => {
      if (Array.isArray(key)) {
        throw new Error('consume does not accept key arrays');
      }
      const value = await redisClient?.sendCommand(['GETDEL', key]);
      if (!value || typeof value !== 'string') {
        return undefined;
      }
      try {
        return unserialize(value);
      } catch (err) {
        debugCache(`Invalid JSON (${value}): ${err}`);
      }
    },
  };
};

export default makeRedisProvider;
