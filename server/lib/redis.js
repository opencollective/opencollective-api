import config from 'config';
import { get } from 'lodash';
import { createClient } from 'redis';

import logger from './logger';

export async function createRedisClient({ serverUrl, name = 'unknown' } = {}) {
  const url = serverUrl || get(config, 'redis.serverUrl');
  if (!url) {
    return;
  }

  const redisOptions = { url };
  if (redisOptions.url.includes('rediss://')) {
    redisOptions.socket = { tls: true, rejectUnauthorized: false };
  }

  let redisClient = createClient(redisOptions);
  try {
    redisClient.on('error', err => logger.error(`Redis "${name}" error`, err));
    redisClient.on('reconnecting', () => logger.info(`Redis "${name}" reconnecting`));
    redisClient.on('connect', () => logger.info(`Redis "${name}" connected`));
    redisClient.on('ready', () => logger.info(`Redis "${name}" ready`));
    redisClient.on('end', () => logger.info(`Redis "${name}" connection closed`));

    await redisClient.connect();
  } catch (err) {
    logger.error(`Redis "${name}" connection error`, err);
    redisClient = null;
  }

  return redisClient;
}
