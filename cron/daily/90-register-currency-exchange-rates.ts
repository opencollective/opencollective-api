import '../../server/env';

import { SUPPORTED_CURRENCIES } from '../../server/constants/currencies';
import { fetchFxRates } from '../../server/lib/currency';
import logger from '../../server/lib/logger';
import models from '../../server/models';
import { runCronJob } from '../utils';

/**
 * Stores the rates from USD to every supported currency. The other pairs are computed from them by
 * `fx_rate`, so one request to the provider covers every pair.
 */
export const run = async (): Promise<void> => {
  logger.info(`Storing FX rates from USD to ${SUPPORTED_CURRENCIES}...`);

  // No DB fallback: saving the stored rates again as today's would hide the failure
  const rates = await fetchFxRates('USD', [...SUPPORTED_CURRENCIES], 'latest', { fallbackToDb: false });
  const storedCurrencies = await models.UsdExchangeRate.record(rates);
  if (!storedCurrencies.length) {
    throw new Error('Could not fetch the exchange rates from USD');
  }

  const missingCurrencies = SUPPORTED_CURRENCIES.filter(
    currency => currency !== 'USD' && !storedCurrencies.includes(currency),
  );
  if (missingCurrencies.length) {
    throw new Error(`No valid exchange rate returned for: ${missingCurrencies.join(', ')}`);
  }

  logger.info('Done.');
};

if (require.main === module) {
  runCronJob('register-currency-exchange-rates', run, 24 * 60 * 60);
}
