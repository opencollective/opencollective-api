import './env';
import './open-telemetry';

import os from 'os';

import config from 'config';
import express from 'express';
import throng from 'throng';

import { startElasticSearchPostgresSync } from './lib/elastic-search/sync-postgres';
import expressLib from './lib/express';
import logger from './lib/logger';
import { updateCachedFidoMetadata } from './lib/two-factor-authentication/fido-metadata';
import { parseToBoolean } from './lib/utils';
import routes from './routes';

const workers = process.env.WEB_CONCURRENCY || 1;

async function startExpressServer(workerId) {
  const expressApp = express();

  await updateCachedFidoMetadata();
  await expressLib(expressApp);

  /**
   * Routes.
   */
  await routes(expressApp);

  /**
   * Start server
   */
  const server = expressApp.listen(config.port, () => {
    const host = os.hostname();
    logger.info(
      'Open Collective API listening at http://%s:%s in %s environment. Worker #%s',
      host,
      server.address().port,
      config.env,
      workerId,
    );
  });

  server.timeout = 25000; // sets timeout to 25 seconds
  expressApp.__server__ = server;

  return expressApp;
}

// Start the express server
let app;
if (parseToBoolean(config.services.server)) {
  if (['production', 'staging'].includes(config.env) && workers > 1) {
    throng({ worker: startExpressServer, count: workers });
  } else {
    app = startExpressServer(1);
  }
}

// Start the search sync job
if (parseToBoolean(config.services.searchSync)) {
  startElasticSearchPostgresSync();
}

// This is used by tests
export default async function startServerForTest() {
  return app ? app : parseToBoolean(config.services.server) ? startExpressServer(1) : null;
}
