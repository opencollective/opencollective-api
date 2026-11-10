import '../../server/env';

import { keys, without } from 'lodash';

import { SUPPORTED_CURRENCIES } from '../../server/constants/currencies';
import { fetchFxRates } from '../../server/lib/currency';
import logger from '../../server/lib/logger';
import { reportErrorToSentry, reportMessageToSentry } from '../../server/lib/sentry';
import models from '../../server/models';
import { runCronJob } from '../utils';

const PLATFORM_BASE_CURRENCY = 'USD';
const CURRENCIES_TO_FETCH = without(SUPPORTED_CURRENCIES, PLATFORM_BASE_CURRENCY);

/**
 * Stores the rates from every supported currency to every other one. A failure on one base
 * currency is reported and skipped, so it can't stop the rates of the currencies after it from
 * being recorded. The job still fails at the end so the problem stays visible.
 */
export const run = async (): Promise<void> => {
  logger.info(`Storing FX rates for ${CURRENCIES_TO_FETCH}...`);

  const failedCurrencies: string[] = [];
  for (const currency of SUPPORTED_CURRENCIES) {
    try {
      const currencyRates = await fetchFxRates(currency, [...SUPPORTED_CURRENCIES]);
      const targetCurrencies = keys(currencyRates);
      if (targetCurrencies.length) {
        const exchangeRates = targetCurrencies.map(to => ({
          from: currency,
          to,
          rate: currencyRates[to],
        }));

        await models.CurrencyExchangeRate.bulkCreate(exchangeRates);
      } else {
        failedCurrencies.push(currency);
        logger.error(`Could not fetch exchange rates for ${currency}`);
        reportMessageToSentry(`Could not fetch exchange rates for currency`, { extra: { currency } });
      }
    } catch (error) {
      failedCurrencies.push(currency);
      logger.error(`Could not store exchange rates for ${currency}: ${error.message}`);
      reportErrorToSentry(error, { extra: { currency } });
    }
  }

  if (failedCurrencies.length) {
    throw new Error(`Could not store exchange rates for: ${failedCurrencies.join(', ')}`);
  }

  logger.info('Done.');
};

if (require.main === module) {
  runCronJob('register-currency-exchange-rates', run, 24 * 60 * 60);
}
