import debugLib from 'debug';

import logger from './logger';
import { createRedisClient } from './redis';
import { sleep } from './utils';

const debug = debugLib('mutex');

/**
 * Cache based, service-wide mutex implementation.
 */
export async function lockUntilResolved<T>(
  key: string,
  until: () => Promise<T>,
  { lockAcquireTimeoutMs = 15 * 1000, unlockTimeoutMs = 60 * 1000, retryDelayMs = 100 } = {},
): Promise<T> {
  const redis = await createRedisClient();
  if (!redis) {
    logger.warn(`Redis is not available, ${key} running without a mutex lock!`);
    return until();
  }
  const _key = `lock:${key}`;
  const start = Date.now();
  let lockAcquired = await redis.mSetNX([_key, '1']);
  while (!lockAcquired) {
    debug(`Waiting for lock ${_key}`);
    await sleep(retryDelayMs);
    lockAcquired = await redis.mSetNX([_key, '1']);
    if (Date.now() - start > lockAcquireTimeoutMs) {
      debug(`Timeouted waiting for lock ${_key}`);
      throw new Error(`Timeout to acquire lock for key ${_key}`);
    }
  }

  await redis.expire(_key, unlockTimeoutMs / 1000);
  debug(`Acquired lock ${_key}`);
  return until().finally(async () => {
    await redis.del(_key);
    debug(`Released lock ${_key}`);
  });
}
