import config from 'config';
import StatsD from 'node-statsd';

import logger from './logger';
import { parseToBoolean } from './utils';

let statsdClient = null;

export function getStatsdClient() {
  if (!statsdClient) {
    if (parseToBoolean(config.statsd.enabled)) {
      statsdClient = new StatsD(config.statsd.url, Number(config.statsd.port), config.statsd.prefix);
    }
  }

  return statsdClient;
}

export function timing(stat, time) {
  const client = getStatsdClient();
  if (client) {
    try {
      client.timing(stat, time);
    } catch (error) {
      logger.error(`StatsD timing error: ${error.message}`);
    }
  }
}
