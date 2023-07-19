import config from 'config';
import moment from 'moment';

import { TOKEN_EXPIRATION_CSV } from './auth.js';
import { fetchWithTimeout } from './fetch.js';
import logger from './logger.js';
import { parseToBoolean } from './utils.js';

export const getTransactionsCsvUrl = (type, collective, options = {}) => {
  const url = new URL(`${config.host.rest}/v2/${collective.slug}/${type}.csv`);

  const { startDate, endDate, kind, add, remove, fields } = options;

  if (startDate) {
    url.searchParams.set('dateFrom', moment.utc(startDate).toISOString());
  }
  if (endDate) {
    url.searchParams.set('dateTo', moment.utc(endDate).toISOString());
  }
  if (kind) {
    url.searchParams.set('kind', kind.join(','));
  }
  if (add) {
    url.searchParams.set('add', kind.join(','));
  }
  if (remove) {
    url.searchParams.set('remove', remove.join(','));
  }
  if (fields) {
    url.searchParams.set('fields', fields.join(','));
  }

  url.searchParams.set('fetchAll', '1');

  return url.toString();
};

const getTransactionsCsv = async (type, collective, { useAdminAccount, ...options } = {}) => {
  const url = getTransactionsCsvUrl(type, collective, options);

  const headers = {};

  // Set the Authorization header if we're using an admin account
  if (useAdminAccount) {
    const [adminUser] = await collective.getAdminUsers();
    if (adminUser) {
      const accessToken = adminUser.jwt({}, TOKEN_EXPIRATION_CSV);
      headers.Authorization = `Bearer ${accessToken}`;
    }
  }

  return fetchWithTimeout(url, { method: 'get', headers, timeoutInMs: 5 * 60 * 1000 })
    .then(response => {
      const { status } = response;
      if (status >= 200 && status < 300) {
        return response.text();
      } else {
        logger.warn('Failed to fetch CSV');
        return null;
      }
    })
    .catch(error => {
      logger.error(`Error fetching CSV: ${error.message}`);
    });
};

export const getCollectiveTransactionsCsv = async (collective, options) => {
  if (parseToBoolean(config.restService.fetchCollectiveTransactionsCsv) === false) {
    return;
  }

  return getTransactionsCsv('transactions', collective, options);
};

export const getHostTransactionsCsvAsAdmin = async (collective, options) => {
  if (parseToBoolean(config.restService.fetchHostTransactionsCsv) === false) {
    return;
  }

  return getTransactionsCsv('hostTransactions', collective, { ...options, useAdminAccount: true });
};
