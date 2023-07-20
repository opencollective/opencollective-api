import config from 'config';

import app from '../../server/index.js';

/**
 * Starts the server and returns a promise that resolves when the server is listening.
 * This should be used in tests in combination with `stopTestServer()` to ensure that the server is stopped,
 * which is a requirement to work with `--watch`.
 */
export const startTestServer = async () => {
  const expressApp = await app();
  if (!expressApp.__server__.listening) {
    expressApp.__server__.listen(config.port);
  }

  return expressApp;
};

/**
 * Stops the server and returns a promise that resolves when the server is stopped
 */
export const stopTestServer = async () => {
  const expressApp = await app();
  if (expressApp.__server__.listening) {
    await new Promise(resolve => expressApp.__server__.close(resolve));
  }

  return expressApp;
};
