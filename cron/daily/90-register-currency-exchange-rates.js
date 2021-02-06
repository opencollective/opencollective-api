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
  const rates = await fetchFxRates('USD', CURRENCIES_TO_FETCH);
  const currencies = keys(rates);

  if (currencies.length) {
    const exchangeRates = currencies.map(to => ({
      from: 'USD',
      to,
      rate: rates[to],
    }));

    await models.CurrencyExchangeRate.bulkCreate(exchangeRates);

    logger.info('Done.');
  } else {
    logger.error('Could not fetch exchange rates.');
  }
  process.exit();
};

run();
