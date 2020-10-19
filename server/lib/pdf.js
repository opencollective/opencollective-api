import config from 'config';
import fetch from 'node-fetch';

import { TOKEN_EXPIRATION_LOGIN } from '../lib/auth';
import logger from '../lib/logger';

export const getTransactionPdf = async (transaction, user) => {
  if (['ci', 'test'].includes(config.env)) {
    return;
  }
  const pdfUrl = `${config.host.pdf}/transactions/${transaction.uuid}/invoice.pdf`;
  const accessToken = user.jwt({}, TOKEN_EXPIRATION_LOGIN);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
  };
  return await fetch(pdfUrl, { method: 'get', headers })
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
      logger.error(`Error fetching PDF: ${error}`);
    });
};
