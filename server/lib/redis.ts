import config from 'config';
import { get } from 'lodash';
import { createClient, RedisClientType } from 'redis';

import logger from './logger';

let redisClient;

export async function createRedisClient(): Promise<RedisClientType> {
  if (!redisClient) {
    const url = get(config, 'redis.serverUrl');
    if (!url) {
      return;
    }

    const redisOptions = { url };
    if (redisOptions.url.includes('rediss://')) {
      redisOptions['socket'] = { tls: true, rejectUnauthorized: false };
    }

    redisClient = createClient(redisOptions);
    try {
      redisClient.on('error', err => logger.error(`Redis error`, err));
      redisClient.on('reconnecting', () => logger.info(`Redis reconnecting`));
      redisClient.on('connect', () => logger.info(`Redis connected`));
      redisClient.on('ready', () => logger.info(`Redis ready`));
      redisClient.on('end', () => logger.info(`Redis connection closed`));

      await redisClient.connect();
    } catch (err) {
      logger.error(`Redis connection error`, err);
      redisClient = null;
    }
  }

  return redisClient;
}

export async function closeRedisClient() {
  if (redisClient) {
    await redisClient.disconnect();
  }
  redisClient = null;
}
