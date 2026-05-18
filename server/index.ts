import './env';
import './lib/sentry/init';
import './open-telemetry';

import cluster from 'cluster';
import { AddressInfo } from 'net';
import os from 'os';

import * as Sentry from '@sentry/node';
import config from 'config';
import express from 'express';
import { toInteger } from 'lodash';

import setupExpress from './lib/express';
import logger from './lib/logger';
import { createRedisClient, RedisInstanceType } from './lib/redis';
import { reportErrorToSentry } from './lib/sentry';
import { updateCachedFidoMetadata } from './lib/two-factor-authentication/fido-metadata';
import { parseToBoolean } from './lib/utils';
import { startExportWorker } from './workers/exports';
import { startSearchSyncWorker } from './workers/search-sync';
import { sequelize } from './models';
import routes from './routes';

const workers = toInteger(process.env.WEB_CONCURRENCY) || 1;
const useCluster = ['production', 'staging'].includes(config.env) && workers > 1;

async function startExpressServer(workerId) {
  const expressApp = express();

  await updateCachedFidoMetadata();
  const redisClient = await createRedisClient(RedisInstanceType.SESSION);
  setupExpress(expressApp, redisClient);

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

// In cluster primary: fork workers and forward shutdown signals to them
if (useCluster && cluster.isPrimary) {
  logger.info(`Starting ${workers} cluster workers...`);
  for (let i = 0; i < workers; i++) {
    cluster.fork();
  }

  let isPrimaryShuttingDown = false;
  cluster.on('exit', (worker, code, signal) => {
    if (!isPrimaryShuttingDown) {
      logger.warn(`Cluster worker #${worker.id} died (${signal || code}), restarting...`);
      cluster.fork();
    }
  });

  const shutdownPrimary = signal => {
    if (!isPrimaryShuttingDown) {
      logger.info(`Primary received ${signal}. Forwarding to cluster workers.`);
      isPrimaryShuttingDown = true;
      for (const worker of Object.values(cluster.workers ?? {})) {
        worker?.process.kill(signal);
      }
    }
  };

  process.on('SIGINT', () => shutdownPrimary('SIGINT'));
  process.on('SIGTERM', () => shutdownPrimary('SIGTERM'));
}

// Start the express server (in cluster worker or non-clustered mode)
let appPromise: Promise<express.Express> | undefined;
if (parseToBoolean(config.services.server) && (!useCluster || cluster.isWorker)) {
  const workerId = useCluster && cluster.worker ? cluster.worker.id : 1;
  appPromise = startExpressServer(workerId);
}

// Start the search sync job
const pStopSearchSyncWorker = startSearchSyncWorker();
const pStopExportWorker = startExportWorker();

let isShuttingDown = false;
const gracefullyShutdown = async signal => {
  if (!isShuttingDown) {
    logger.info(`Received ${signal}. Shutting down.`);
    isShuttingDown = true;

    const stopSearchSyncWorker = await pStopSearchSyncWorker;
    if (stopSearchSyncWorker) {
      await stopSearchSyncWorker();
    }
    const stopExportWorker = await pStopExportWorker;
    if (stopExportWorker) {
      await stopExportWorker();
    }

    if (appPromise) {
      await appPromise.then(app => {
        if (app['__server__']) {
          logger.info('Closing express server');
          app['__server__'].close();
        }
      });
    }

    await sequelize.close();
    process.exit();
  }
};

// Shutdown handlers for worker/non-clustered processes; primary registers its own above
if (!useCluster || cluster.isWorker) {
  process.on('exit', () => gracefullyShutdown('exit'));
  process.on('SIGINT', () => gracefullyShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefullyShutdown('SIGTERM'));
}

// This is used by tests
export default async function startServerForTest() {
  return appPromise ?? startExpressServer(1);
}
