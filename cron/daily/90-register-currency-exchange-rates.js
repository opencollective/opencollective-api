#!/usr/bin/env node
import '../../server/env';

import { keys, without } from 'lodash';

import { SUPPORTED_CURRENCIES } from '../../server/constants/currencies';
import { fetchFxRates } from '../../server/lib/currency';
import logger from '../../server/lib/logger';
import models from '../../server/models';

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
    }
  }

  logger.info('Done.');
  process.exit();
};

run();
