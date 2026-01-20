import config from 'config';
import type express from 'express';

import { isOpenSearchConfigured } from '../lib/open-search/client';
import { startOpenSearchPostgresSync, stopOpenSearchPostgresSync } from '../lib/open-search/sync-postgres';
import { reportErrorToSentry } from '../lib/sentry';
import { parseToBoolean } from '../lib/utils';

import logger from './../lib/logger';

export async function startSearchSyncWorker(appPromise?: Promise<express.Express>) {
  if (!parseToBoolean(config.services.searchSync)) {
    return;
  }

  if (!isOpenSearchConfigured()) {
    logger.warn('OpenSearch is not configured. Skipping sync job.');
    return;
  }

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
              if (app['__server__']) {
                logger.info('Closing express server');
                app['__server__'].close();
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
