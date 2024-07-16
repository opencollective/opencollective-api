import debugLib from 'debug';

import logger from './logger';
import { createRedisClient, RedisInstanceType } from './redis';
import { utils } from './statsd';
import { sleep } from './utils';

const debug = debugLib('mutex');

/**
 * Cache based, service-wide mutex implementation.
 */
export async function lockUntilResolved<T>(
  key: string,
  until: () => Promise<T>,
  { lockAcquireTimeoutMs = 15 * 1000, unlockTimeoutMs = 10 * 60 * 1000, retryDelayMs = 100 } = {},
): Promise<T> {
  const redis = await createRedisClient(RedisInstanceType.SESSION);
  if (!redis) {
    logger.warn(`Redis is not available, ${key} running without a mutex lock!`);
    return until();
  }

  const start = Date.now();
  const _key = `lock:${key}`;
  const stopWatch = utils.stopwatch(`mutex.lockUntilResolved.${_key}`);
  const lock = () => redis.set(_key, 1, { NX: true, PX: unlockTimeoutMs });

  let lockAcquired = await lock();
  while (!lockAcquired) {
    debug(`Waiting for lock ${_key}`);
    await sleep(retryDelayMs);
    lockAcquired = await lock();
    if (Date.now() - start > lockAcquireTimeoutMs) {
      debug(`Timeouted waiting for lock ${_key}`);
      throw new Error(`Timeout to acquire lock for key ${_key}`);
    }
  }

  debug(`Acquired lock ${_key}`);
  return until().finally(async () => {
    await redis.del(_key);
    stopWatch();
    debug(`Released lock ${_key}`);
  });
}

/**
 * Try to atomically acquire a lock for a key, execute the `until` function and release the lock.
 * Throws if the lock can't be acquired.
 *
 * Requires a Redis instance to be available, otherwise it will just run the `until` function.
 */
export async function lockUntilOrThrow<T>(
  key: string,
  until: () => Promise<T>,
  { unlockTimeoutMs = 10 * 60 * 1000 } = {},
): Promise<T> {
  const redis = await createRedisClient(RedisInstanceType.SESSION);
  if (!redis) {
    logger.warn(`Redis is not available, ${key} running without a mutex lock!`);
    return until();
  }

  const _key = `lock:${key}`;
  const lockAcquired = await redis.set(_key, 1, { NX: true, PX: unlockTimeoutMs });
  if (!lockAcquired) {
    debug(`Failed to acquire lock ${_key}`);
    throw new Error(`Failed to acquire lock for key ${_key}`);
  }

  debug(`Acquired lock ${_key}`);
  try {
    const response = await until();
    await redis.del(_key);
    debug(`Released lock ${_key}`);
    return response;
  } catch (e) {
    await redis.del(_key);
    debug(`Released lock ${_key}`);
    throw e;
  }
}
