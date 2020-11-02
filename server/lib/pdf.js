import config from 'config';

import { TOKEN_EXPIRATION_LOGIN } from './auth';
import { fetchWithTimeout } from './fetch';
import logger from './logger';

export const getTransactionPdf = async (transaction, user) => {
  if (config.pdfService.fetchTransactionsReceipts === false) {
    return;
  }
  const pdfUrl = `${config.host.pdf}/transactions/${transaction.uuid}/invoice.pdf`;
  const accessToken = user.jwt({}, TOKEN_EXPIRATION_LOGIN);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
  };

  return fetchWithTimeout(pdfUrl, { method: 'get', headers, timeoutInMs: 10000 })
    .then(response => {
      const { status } = response;
      if (status >= 200 && status < 300) {
        return response.body;
      } else {
        logger.warn('Failed to fetch PDF');
        return null;
      }
    })
    .catch(error => {
      logger.error(`Error fetching PDF: ${error.message}`);
    });
};
