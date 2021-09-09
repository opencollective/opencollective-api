import config from 'config';
import moment from 'moment';

// import { TOKEN_EXPIRATION_CSV } from './auth';
import { fetchWithTimeout } from './fetch';
import logger from './logger';
import { parseToBoolean } from './utils';

export const getTransactionsCsvUrl = async (type, collective, { startDate, endDate, kind } = {}) => {
  const url = new URL(`${config.host.rest}/v2/${collective.slug}/${type}.csv`);

  if (startDate) {
    url.searchParams.set('dateFrom', moment.utc(startDate).toISOString());
  }
  if (endDate) {
    url.searchParams.set('dateTo', moment.utc(endDate).toISOString());
  }
  if (kind) {
    url.searchParams.set('kind', kind.join(','));
  }

  url.searchParams.set('fetchAll', '1');

  return url.toString();
};

const getTransactionsCsv = async (type, collective, { startDate, endDate, kind } = {}) => {
  const url = getTransactionsCsvUrl(type, collective, { startDate, endDate, kind });

  const headers = {};

  // Disable for now
  // const accessToken = user.jwt({}, TOKEN_EXPIRATION_CSV);
  // headers.Authorization = `Bearer ${accessToken}`;

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

export const getCollectiveTransactionsCsv = async (collective, { startDate, endDate, kind } = {}) => {
  if (parseToBoolean(config.restService.fetchCollectiveTransactionsCsv) === false) {
    return;
  }

  return getTransactionsCsv('transactions', collective, { startDate, endDate, kind });
};

export const getHostTransactionsCsv = async (collective, { startDate, endDate } = {}) => {
  if (parseToBoolean(config.restService.fetchHostTransactionsCsv) === false) {
    return;
  }

  return getTransactionsCsv('hostTransactions', collective, { startDate, endDate });
};
