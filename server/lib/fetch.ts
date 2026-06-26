import { get, omit } from 'lodash';

import logger from './logger';

type FetchOptions = RequestInit & { timeoutInMs?: number };

/**
 * Make a fetch call with a timeout. Returns a thenable Promise.
 */
export const fetchWithTimeout = (url: string, fetchOptions: FetchOptions): Promise<Response> => {
  const timeoutInMs = get(fetchOptions, 'timeoutInMs', 5000);
  const externalSignal = fetchOptions.signal;
  const restOptions = omit(fetchOptions, 'timeoutInMs');

  const timeoutSignal = AbortSignal.timeout(timeoutInMs);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;

  return fetch(url, { ...restOptions, signal })
    .then(response => {
      logger.info(`Fetch request to ${url} successful`);
      return response;
    })
    .catch(err => {
      if (err.name === 'TimeoutError' || (timeoutSignal.aborted && !externalSignal?.aborted)) {
        logger.warn(`Fetch request to ${url} timed out`);
        throw new Error(`Fetch request to ${url} timed out`);
      }
      throw new Error(`Fetch error: ${err.message}`);
    });
};
