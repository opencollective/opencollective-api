import config from 'config';
import { get } from 'lodash';
import { createClient, RedisClientType } from 'redis';

import logger from './logger';

export enum RedisInstanceType {
  DEFAULT = 'DEFAULT',
  TIMELINE = 'TIMELINE',
}

const RedisInstanceKey = {
  [RedisInstanceType.DEFAULT]: 'redis.serverUrl',
  [RedisInstanceType.TIMELINE]: 'redis.serverUrlTimeline',
};

// Holds a singleton instance of Redis client for each instance type
const redisInstances: Record<string, RedisClientType> = {};

export async function createRedisClient(
  instanceType: RedisInstanceType = RedisInstanceType.DEFAULT,
): Promise<RedisClientType> {
  const url = get(config, RedisInstanceKey[instanceType]);
  // Fallback to default instance if the requested instance is not configured
  if (instanceType !== RedisInstanceType.DEFAULT && !url) {
    logger.warn(`Redis instance ${instanceType} is not configured, falling back to default instance`);
    instanceType = RedisInstanceType.DEFAULT;
  }

  // Return the existing client if it exists
  if (redisInstances[instanceType]) {
    return redisInstances[instanceType];
  }
  // Return null if the instance is not configured
  else if (!url) {
    return;
  }

  const redisOptions = { url };
  if (redisOptions.url.includes('rediss://')) {
    redisOptions['socket'] = { tls: true, rejectUnauthorized: false };
  }

  try {
    const client = createClient(redisOptions);
    client.on('error', err => logger.error(`Redis error (${instanceType})`, err));
    client.on('reconnecting', () => logger.info(`Redis reconnecting (${instanceType})`));
    client.on('connect', () => logger.info(`Redis connected (${instanceType})`));
    client.on('ready', () => logger.info(`Redis ready (${instanceType})`));
    client.on('end', () => logger.info(`Redis connection closed (${instanceType})`));

    await client.connect();
    redisInstances[instanceType] = client as RedisClientType;
  } catch (err) {
    logger.error(`Redis connection error (${instanceType})`, err);
    redisInstances[instanceType] = null;
  }

  return redisInstances[instanceType];
}

export async function closeRedisClient() {
  for (const instanceType in redisInstances) {
    await redisInstances[instanceType].disconnect();
    delete redisInstances[instanceType];
  }
}
