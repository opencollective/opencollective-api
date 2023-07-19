import { get } from 'lodash-es';
import fetch from 'node-fetch';

import logger from './logger.js';

/**
 * Make a fetch call with a timeout. Returns a thenable Promise.
 * @param {String} url The url to fetch.
 * @param {Object} [fetchOptions] The method, headers, and other options for node-fetch. Default method is GET.
 * @param {Number} [fetchOptions.timeoutInMs] The timeout in ms. Default is 5000.
 */

export const fetchWithTimeout = (url, fetchOptions) => {
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
