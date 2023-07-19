import './env.js';
import './open-telemetry.js';

import os from 'os';

import config from 'config';
import express from 'express';
import throng from 'throng';

import expressLib from './lib/express.js';
import logger from './lib/logger.js';
import routes from './routes.js';

const workers = process.env.WEB_CONCURRENCY || 1;

async function start(i) {
  const expressApp = express();

  await expressLib(expressApp);

  /**
   * Routes.
   */
  await routes(expressApp);

  /**
   * Start server
   */
  const server = expressApp.listen(config.port, async () => {
    const host = os.hostname();
    logger.info(
      'Open Collective API listening at http://%s:%s in %s environment. Worker #%s',
      host,
      server.address().port,
      config.env,
      i,
    );
    if (config.maildev.server) {
      const { default: maildev } = await import('./maildev.js'); // eslint-disable-line @typescript-eslint/no-var-requires
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
