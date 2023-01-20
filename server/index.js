import './env';
import './open-telemetry';

import os from 'os';

import config from 'config';
import express from 'express';
import throng from 'throng';

import expressLib from './lib/express';
import logger from './lib/logger';
import { initSentry, Sentry } from './lib/sentry';
import routes from './routes';

const workers = process.env.WEB_CONCURRENCY || 1;

async function start(i) {
  const expressApp = express();

  // Re-initializing Sentry with express app
  initSentry(expressApp);

  // Sentry's request handler must be the first middleware on the app
  expressApp.use(Sentry.Handlers.requestHandler());
  expressApp.use(Sentry.Handlers.tracingHandler());

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
      i,
    );
    if (config.maildev.server) {
      const maildev = require('./maildev'); // eslint-disable-line @typescript-eslint/no-var-requires
      maildev.listen();
    }
  });

  server.timeout = 25000; // sets timeout to 25 seconds
  expressApp.__server__ = server;

  return expressApp;
}

let app;

if (['production', 'staging'].includes(config.env) && workers && workers > 1) {
  throng({ worker: start, count: workers });
} else {
  app = start(1);
}

// This is used by tests
export default async function () {
  return app ? app : start(1);
}
