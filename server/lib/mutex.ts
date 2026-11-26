import { randomBytes } from 'crypto';

import debugLib from 'debug';

import logger from './logger';
import { createRedisClient, RedisInstanceType } from './redis';
import { sleep } from './utils';

const debug = debugLib('mutex');

export const MutexLockError = class extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutexLockError';
  }
};

type ReleaseLock = () => Promise<number>;
type ExtendLock = (ttlMs?: number) => Promise<boolean>;

/**
 * Fenced lock operations: the lock value is a unique token, so a run can only release or renew the lock it
 * still owns. A lock that expired and was taken over by another run is never deleted or extended here.
 */
const RELEASE_LOCK_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;
const EXTEND_LOCK_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  return 0
`;

/**
 * Cache based, service-wide mutex implementation.
 */
export async function lockUntilResolved<T>(
  key: string,
  until: (release?: () => Promise<number>) => Promise<T>,
  { lockAcquireTimeoutMs = 15 * 1000, unlockTimeoutMs = 10 * 60 * 1000, retryDelayMs = 100 } = {},
): Promise<T> {
  const redis = await createRedisClient(RedisInstanceType.SESSION);
  if (!redis) {
    logger.warn(`Redis is not available, ${key} running without a mutex lock!`);
    return until();
  }

  const start = Date.now();
  const _key = `lock:${key}`;
  const lock = () => redis.set(_key, 1, { NX: true, PX: unlockTimeoutMs });

  let lockAcquired = await lock();
  while (!lockAcquired) {
    debug(`Waiting for lock ${_key}`);
    await sleep(retryDelayMs);
    lockAcquired = await lock();
    if (Date.now() - start > lockAcquireTimeoutMs) {
      debug(`Timeouted waiting for lock ${_key}`);
      throw new MutexLockError(`Timeout to acquire lock for key ${_key}`);
    }
  }

  const release = () => redis.del(_key);
  debug(`Acquired lock ${_key}`);
  return until(release).finally(async () => {
    await release();
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
  until: (release?: ReleaseLock, extend?: ExtendLock) => Promise<T>,
  { unlockTimeoutMs = 10 * 60 * 1000 } = {},
): Promise<T> {
  const redis = await createRedisClient(RedisInstanceType.SESSION);
  if (!redis) {
    logger.warn(`Redis is not available, ${key} running without a mutex lock!`);
    return until();
  }

  const _key = `lock:${key}`;
  const token = randomBytes(16).toString('hex');
  const lockAcquired = await redis.set(_key, token, { NX: true, PX: unlockTimeoutMs });
  if (lockAcquired) {
    debug(`Acquired lock ${_key}`);
    const release = async () =>
      Number(await redis.eval(RELEASE_LOCK_SCRIPT, { keys: [_key], arguments: [token] })) || 0;
    const extend: ExtendLock = async (ttlMs = unlockTimeoutMs) =>
      Number(await redis.eval(EXTEND_LOCK_SCRIPT, { keys: [_key], arguments: [token, String(ttlMs)] })) === 1;
    try {
      return await until(release, extend);
    } finally {
      await release();
      debug(`Released lock ${_key}`);
    }
  } else {
    debug(`Failed to acquire lock ${_key}`);
    throw new MutexLockError(`Failed to acquire lock for key ${_key}`);
  }
}
