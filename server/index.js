import './env';
import './open-telemetry';

import os from 'os';

import config from 'config';
import express from 'express';
import throng from 'throng';

import { isElasticSearchConfigured } from './lib/elastic-search/client';
import { startElasticSearchPostgresSync, stopElasticSearchPostgresSync } from './lib/elastic-search/sync-postgres';
import expressLib from './lib/express';
import logger from './lib/logger';
import { reportErrorToSentry } from './lib/sentry';
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
  if (!isElasticSearchConfigured()) {
    logger.warn('ElasticSearch is not configured. Skipping sync job.');
  } else {
    startElasticSearchPostgresSync()
      .catch(e => {
        // We don't want to crash the server if the sync job fails to start
        logger.error('Failed to start ElasticSearch sync job', e);
        reportErrorToSentry(e);
      })
      .then(() => {
        // Add a handler to make sure we flush the Elastic Search sync queue before shutting down
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

            await stopElasticSearchPostgresSync();
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
