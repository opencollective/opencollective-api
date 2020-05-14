import './env';

import os from 'os';

import config from 'config';
import express from 'express';

import expressLib from './lib/express';
import logger from './lib/logger';
import routes from './routes';

async function init() {
  // Load stubs for E2E tests
  if (process.env.E2E_TEST || process.env.CI) {
    require('../test/mocks/e2e');
  }
  const expressApp = express();

  await expressLib(expressApp);

  /**
   * Routes.
   */
  routes(expressApp);

  /**
   * Start server
   */
  const server = expressApp.listen(config.port, () => {
    const host = os.hostname();
    logger.info(
      'Open Collective API listening at http://%s:%s in %s environment.\n',
      host,
      server.address().port,
      config.env,
    );
    if (config.maildev.server) {
      const maildev = require('./maildev'); // eslint-disable-line @typescript-eslint/no-var-requires
      maildev.listen();
    }
  });

  server.timeout = 25000; // sets timeout to 25 seconds

  return expressApp;
}

const app = init();

export default async function () {
  return app;
}
