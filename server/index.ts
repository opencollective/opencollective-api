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
import { isOpenSearchConfigured } from './lib/open-search/client';
import { startOpenSearchPostgresSync, stopOpenSearchPostgresSync } from './lib/open-search/sync-postgres';
import { reportErrorToSentry } from './lib/sentry';
import { updateCachedFidoMetadata } from './lib/two-factor-authentication/fido-metadata';
import { parseToBoolean } from './lib/utils';
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
let appPromise;
if (parseToBoolean(config.services.server)) {
  if (['production', 'staging'].includes(config.env) && workers > 1) {
    throng({ worker: startExpressServer, count: workers }); // TODO: Thong is not compatible with the shutdown logic below
  } else {
    appPromise = startExpressServer(1);
  }
}

// Start the search sync job
if (parseToBoolean(config.services.searchSync)) {
  if (!isOpenSearchConfigured()) {
    logger.warn('OpenSearch is not configured. Skipping sync job.');
  } else {
    startOpenSearchPostgresSync()
      .catch(e => {
        // We don't want to crash the server if the sync job fails to start
        logger.error('Failed to start OpenSearch sync job', e);
        reportErrorToSentry(e);
      })
      .then(() => {
        // Add a handler to make sure we flush the OpenSearch sync queue before shutting down
        let isShuttingDown = false;
        const gracefullyShutdown = async signal => {
          if (!isShuttingDown) {
            logger.info(`Received ${signal}. Shutting down.`);
            isShuttingDown = true;

            if (appPromise) {
              await appPromise.then(app => {
                if (app.__server__) {
                  logger.info('Closing express server');
                  app.__server__.close();
                }
              });
            }

            await stopOpenSearchPostgresSync();
            process.exit();
          }
        };

        process.on('exit', () => gracefullyShutdown('exit'));
        process.on('SIGINT', () => gracefullyShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefullyShutdown('SIGTERM'));
      });
  }
}

// This is used by tests
export default async function startServerForTest() {
  return appPromise ?? startExpressServer(1);
}
