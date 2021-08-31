import config from 'config';
import moment from 'moment';

// import { TOKEN_EXPIRATION_CSV } from './auth';
import { fetchWithTimeout } from './fetch';
import logger from './logger';
import { parseToBoolean } from './utils';

export const getCollectiveTransactionsCsv = async (collective, { startDate, endDate } = {}) => {
  if (parseToBoolean(config.restService.fetchCollectiveTransactionsCsv) === false) {
    return;
  }

  const url = new URL(`${config.host.rest}/v2/${collective.slug}/transactions.csv`);
  if (startDate) {
    url.searchParams.set('dateFrom', moment.utc(startDate).toISOString());
  }
  if (endDate) {
    url.searchParams.set('dateTo', moment.utc(endDate).toISOString());
  }

  const headers = {};

  // Disable for now
  // const accessToken = user.jwt({}, TOKEN_EXPIRATION_CSV);
  // headers.Authorization = `Bearer ${accessToken}`;

  return fetchWithTimeout(url, { method: 'get', headers, timeoutInMs: 10000 })
    .then(response => {
      const { status } = response;
      if (status >= 200 && status < 300) {
        return response.body;
      } else {
        logger.warn('Failed to fetch CSV');
        return null;
      }
    })
    .catch(error => {
      logger.error(`Error fetching CSV: ${error.message}`);
    });
};
