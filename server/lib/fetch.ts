import { get } from 'lodash';
import fetch, { RequestInit, Response } from 'node-fetch';

import logger from './logger';

type FetchOptions = RequestInit & { timeoutInMs?: number };

/**
 * Make a fetch call with a timeout. Returns a thenable Promise.
 */

export const fetchWithTimeout = (url: string, fetchOptions: FetchOptions): Promise<Response> => {
  const timeoutInMs = get(fetchOptions, 'timeoutInMs', 5000);

  return new Promise((resolve, reject) => {
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      logger.warn(`Fetch request to ${url} timed out`);
      return reject(new Error(`Fetch request to ${url} timed out`));
    }, timeoutInMs);

    fetch(url, fetchOptions)
      .then(
        response => {
          if (!timedOut) {
            logger.info(`Fetch request to ${url} successful`);
            return resolve(response);
          }
        },
        err => {
          if (timedOut) {
            return;
          }
          return reject(new Error(`Fetch error: ${err.message}`));
        },
      )
      .finally(() => {
        clearTimeout(timer);
      });
  });
};
