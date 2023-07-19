#!/usr/bin/env node
import '../../server/env.js';
import '../../server/lib/sentry.js';

import { keys, without } from 'lodash-es';

import { SUPPORTED_CURRENCIES } from '../../server/constants/currencies.js';
import { fetchFxRates } from '../../server/lib/currency.js';
import logger from '../../server/lib/logger.js';
import { reportMessageToSentry } from '../../server/lib/sentry.js';
import models from '../../server/models/index.js';

const PLATFORM_BASE_CURRENCY = 'USD';
const CURRENCIES_TO_FETCH = without(SUPPORTED_CURRENCIES, PLATFORM_BASE_CURRENCY);

const run = async () => {
  logger.info(`Storing FX rates for ${CURRENCIES_TO_FETCH}...`);

  for (const currency of SUPPORTED_CURRENCIES) {
    const currencyRates = await fetchFxRates(currency, SUPPORTED_CURRENCIES);
    const targetCurrencies = keys(currencyRates);
    if (targetCurrencies.length) {
      const exchangeRates = targetCurrencies.map(to => ({
        from: currency,
        to,
        rate: currencyRates[to],
      }));

      await models.CurrencyExchangeRate.bulkCreate(exchangeRates);
    } else {
      logger.error(`Could not fetch exchange rates for ${currency}`);
      reportMessageToSentry(`Could not fetch exchange rates for currency`, { extra: { currency } });
    }
  }

  logger.info('Done.');
  process.exit();
};

run();
