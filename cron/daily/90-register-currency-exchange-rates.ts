import '../../server/env';

import { keys } from 'lodash';

import { SUPPORTED_CURRENCIES } from '../../server/constants/currencies';
import { fetchFxRates } from '../../server/lib/currency';
import logger from '../../server/lib/logger';
import models from '../../server/models';
import { runCronJob } from '../utils';

/**
 * Stores the rates from USD to every supported currency. The other pairs are computed from them by
 * the "CurrencyExchangeRates" view, so one request to the provider covers every pair.
 */
export const run = async (): Promise<void> => {
  logger.info(`Storing FX rates from USD to ${SUPPORTED_CURRENCIES}...`);

  // No DB fallback: saving the stored rates again as today's would hide the failure
  const rates = await fetchFxRates('USD', [...SUPPORTED_CURRENCIES], 'latest', { fallbackToDb: false });
  const currencies = keys(rates);
  if (!currencies.length) {
    throw new Error('Could not fetch the exchange rates from USD');
  }

  await models.CurrencyExchangeRate.bulkCreate(currencies.map(to => ({ from: 'USD', to, rate: rates[to] })));

  const missingCurrencies = SUPPORTED_CURRENCIES.filter(currency => currency !== 'USD' && !rates[currency]);
  if (missingCurrencies.length) {
    throw new Error(`No exchange rate returned for: ${missingCurrencies.join(', ')}`);
  }

  logger.info('Done.');
};

if (require.main === module) {
  runCronJob('register-currency-exchange-rates', run, 24 * 60 * 60);
}
