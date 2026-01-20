import './env';
import './lib/sentry/init';
import './open-telemetry';

import { AddressInfo } from 'net';
import os from 'os';

import * as Sentry from '@sentry/node';
import config from 'config';
import express from 'express';
import { isUndefined, toInteger } from 'lodash';
import throng from 'throng';

import setupExpress from './lib/express';
import logger from './lib/logger';
import { reportErrorToSentry } from './lib/sentry';
import { updateCachedFidoMetadata } from './lib/two-factor-authentication/fido-metadata';
import { parseToBoolean } from './lib/utils';
import { startSearchSyncWorker } from './workers/search-sync';
import routes from './routes';

const workers = isUndefined(process.env.WEB_CONCURRENCY) ? toInteger(process.env.WEB_CONCURRENCY) : 1;

async function startExpressServer(workerId) {
  const expressApp = express();

  await updateCachedFidoMetadata();
  await setupExpress(expressApp);

  /**
   * Routes.
   */
  await routes(expressApp);

  Sentry.setupExpressErrorHandler(expressApp);

  /**
   * Start server
   */
  const server = expressApp.listen(config.port, () => {
    const host = os.hostname();
    logger.info(
      'Open Collective API listening at http://%s:%s in %s environment. Worker #%s',
      host,
      (server.address() as AddressInfo).port,
      config.env,
      workerId,
    );
  });
  server.on('error', error => {
    logger.error('Failed to start Express server', error);
    reportErrorToSentry(error);
  });

  server.timeout = 25000; // sets timeout to 25 seconds
  expressApp['__server__'] = server;

  return expressApp;
}

// Start the express server
let appPromise: Promise<express.Express> | undefined;
if (parseToBoolean(config.services.server)) {
  if (['production', 'staging'].includes(config.env) && workers > 1) {
    throng({ worker: startExpressServer, count: workers }); // TODO: Thong is not compatible with the shutdown logic below
  } else {
    appPromise = startExpressServer(1);
  }
}

// Start the search sync job
startSearchSyncWorker(appPromise);

// This is used by tests
export default async function startServerForTest() {
  return appPromise ?? startExpressServer(1);
}
