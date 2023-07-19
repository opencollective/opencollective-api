import config from 'config';
import debugLib from 'debug';
import { difference, get, has, keys, merge, uniq, zipObject } from 'lodash-es';
import fetch from 'node-fetch';

import { currencyFormats, SUPPORTED_CURRENCIES } from '../constants/currencies.js';
import models from '../models/index.js';

import cache from './cache/index.js';
import logger from './logger.js';
import { reportErrorToSentry, reportMessageToSentry } from './sentry.js';

const debug = debugLib('currency');

function getDate(date: string | Date = 'latest') {
  if (typeof date === 'string') {
    return date;
  } else if (date.getFullYear) {
    date.setTime(date.getTime() + date.getTimezoneOffset() * 60 * 1000);
    const mm = date.getMonth() + 1; // getMonth() is zero-based
    const dd = date.getDate();
    return [date.getFullYear(), (mm > 9 ? '' : '0') + mm, (dd > 9 ? '' : '0') + dd].join('-');
  }
}

export function formatCurrency(currency: string, value: number): string {
  const _currency = currency.toUpperCase();
  const currencyStr = currencyFormats[_currency];

  if (!currencyStr) {
    return `${value} ${_currency}`;
  }
  return currencyStr.concat(value);
}

if (!get(config, 'fixer.accessKey') && !['staging', 'production'].includes(config.env)) {
  logger.info('Fixer API is not configured, lib/currency will always return 1.1');
}

export const getRatesFromDb = async (
  fromCurrency: string,
  toCurrencies: string[],
  date: string | Date = 'latest',
): Promise<Record<string, number>> => {
  // TODO: This function is a bit messy, refactor it

  const hasOnlyOneCurrency = toCurrencies.length === 1;
  let isInverted = false;
  if (!SUPPORTED_CURRENCIES.includes(fromCurrency)) {
    isInverted = true;
    if (!hasOnlyOneCurrency || !SUPPORTED_CURRENCIES.includes(toCurrencies[0])) {
      // Can only convert *currency* -> *one of the supported currency* at the moment (so we don't support multiple targets)
      logger.warn(
        `getRatesFromDb: Tried to convert ${fromCurrency} to ${toCurrencies.join(', ')}, which is not supported `,
      );
      throw new Error(
        'We are not able to fetch some currencies FX rate at the moment, some statistics may be unavailable',
      );
    }
  }

  // Fetch rates
  const [from, to] = isInverted ? [toCurrencies[0], [fromCurrency]] : [fromCurrency, toCurrencies];
  const allRates = await models.CurrencyExchangeRate.getMany(from, to, date);
  const result = {};
  let missingCurrencies = [];
  if (isInverted) {
    allRates.forEach(rate => (result[from] = 1 / rate.rate));
  } else {
    allRates.forEach(rate => (result[rate.to] = rate.rate));
  }

  // Make sure we got all currencies
  missingCurrencies = to.filter(currency => !has(result, currency));
  if (missingCurrencies.length > 0) {
    // When doing 1 on 1 conversion with supported currencies, try to fetch the opposite if it fails
    if (
      !isInverted &&
      hasOnlyOneCurrency &&
      SUPPORTED_CURRENCIES.includes(toCurrencies[0]) &&
      SUPPORTED_CURRENCIES.includes(fromCurrency)
    ) {
      const usdRates = await models.CurrencyExchangeRate.getMany(toCurrencies[0], [fromCurrency], date);
      if (usdRates[0]) {
        result[toCurrencies[0]] = 1 / usdRates[0].rate;
        missingCurrencies = [];
      }
    }

    // If some currencies are still missing, we have no choice but to throw an error
    if (missingCurrencies.length > 0) {
      logger.error(`FX rate error: missing currencies in CurrencyExchangeRate: ${missingCurrencies.join(', ')}`);
      reportMessageToSentry('FX rate error: missing currencies in CurrencyExchangeRate', {
        extra: { fromCurrency, toCurrencies, missingCurrencies },
      });
      throw new Error(
        'We are not able to fetch the currency FX rates for some currencies at the moment, some statistics may be unavailable',
      );
    }
  }

  return result;
};

export async function fetchFxRates(
  fromCurrency: string,
  toCurrencies: string[],
  date: string | Date = 'latest',
): Promise<Record<string, number>> {
  date = getDate(date);

  const useFixerApi = Boolean(get(config, 'fixer.accessKey'));
  const isLiveEnv = ['staging', 'production'].includes(config.env);

  // Try to fetch the FX rates from fixer.io
  if (!useFixerApi) {
    logger.info('Fixer API is not configured, lib/currency will always return 1.1');
  } else {
    const params = {
      access_key: config.fixer.accessKey, // eslint-disable-line camelcase
      base: fromCurrency,
      symbols: toCurrencies.join(','),
    };

    const searchParams = Object.keys(params)
      .map(key => `${key}=${params[key]}`)
      .join('&');

    try {
      const res = await fetch(`https://data.fixer.io/${date}?${searchParams}`);
      const json = await res.json();
      if (json.error) {
        throw new Error(json.error.info);
      }
      const rates = {};
      keys(json.rates).forEach(to => {
        rates[to] = parseFloat(json.rates[to]);
        const cacheTtl = date === 'latest' ? 60 * 60 /* 60 minutes */ : null; /* no expiration */
        cache.set(`${date}-${fromCurrency}-${to}`, rates[to], cacheTtl);
      });

      return rates;
    } catch (error) {
      if (!isLiveEnv) {
        logger.info(`Unable to fetch fxRate with Fixer API: ${error.message}. Returning 1.1`);
      } else {
        logger.error(`Unable to fetch fxRate with Fixer API: ${error.message}. Using DB fallback`);
        reportErrorToSentry(error);
      }
    }
  }

  // In case of error or if Fixer API is not configured, fallback to DB/mock values
  if (!isLiveEnv) {
    const ratesValues = toCurrencies.map(() => 1.1);
    return zipObject(toCurrencies, ratesValues);
  } else {
    return getRatesFromDb(fromCurrency, toCurrencies, date);
  }
}

export async function getFxRate(
  fromCurrency: string,
  toCurrency: string,
  date: string | Date = 'latest',
): Promise<number> {
  debug(`getFxRate for ${date} ${fromCurrency} -> ${toCurrency}`);
  fromCurrency = fromCurrency?.toUpperCase();
  toCurrency = toCurrency?.toUpperCase();

  if (fromCurrency === toCurrency) {
    return 1;
  } else if (!fromCurrency || !toCurrency) {
    return 1;
  } else if (!get(config, 'fixer.accessKey')) {
    if (['staging', 'production'].includes(config.env)) {
      throw new Error('Unable to fetch fxRate, Fixer API is not configured.');
    } else {
      return 1.1;
    }
  }

  date = getDate(date);

  const fromCache = await cache.get(`${date}-${fromCurrency}-${toCurrency}`);
  if (fromCache) {
    return fromCache;
  }

  const rates = await fetchFxRates(fromCurrency, [toCurrency], date);

  return rates[toCurrency];
}

/**
 * Same as getFxRate, but optimized to handle multiple `toCurrency`
 */
export async function getFxRates(
  fromCurrency: string,
  toCurrencies: string[],
  date: string | Date = 'latest',
): Promise<Record<string, number>> {
  fromCurrency = fromCurrency?.toUpperCase();
  toCurrencies = uniq(toCurrencies.map(c => c.toUpperCase()));
  date = getDate(date);

  // Retrieve everything we can from the cache
  const rates = {};
  await Promise.all(
    toCurrencies.map(async currency => {
      if (currency === fromCurrency) {
        rates[fromCurrency] = 1;
      } else {
        const fromCache = await cache.get(`${date}-${fromCurrency}-${currency}`);
        if (fromCache) {
          rates[currency] = fromCache;
        }
      }
    }),
  );

  // Return directly if we have everything, fetch additional rates form Fixed/DB otherwise
  if (Object.keys(rates).length === toCurrencies.length) {
    return rates;
  } else {
    const currenciesLeftToFetch = difference(toCurrencies, Object.keys(rates));
    const missingRates = await fetchFxRates(fromCurrency, currenciesLeftToFetch, date);
    return merge(rates, missingRates);
  }
}

export function convertToCurrency(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  date: string | Date = 'latest',
): Promise<number> {
  if (amount === 0) {
    return Promise.resolve(0);
  }
  if (fromCurrency === toCurrency) {
    return Promise.resolve(amount);
  }
  if (!fromCurrency || !toCurrency) {
    return Promise.resolve(amount);
  }

  return getFxRate(fromCurrency, toCurrency, date).then(fxrate => {
    return fxrate * amount;
  });
}

type AmountWithCurrencyAndDate = {
  currency: string;
  amount: number;
  date: Date | string;
};

/**
 * The goal of this function is to return the sum of an array of { currency, amount, date }
 * to one total amount in the given currency
 * @param {*} array [ { currency, amount[, date] }]
 */
export function reduceArrayToCurrency(array: AmountWithCurrencyAndDate[], currency: string): Promise<number> {
  return Promise.all(array.map(entry => convertToCurrency(entry.amount, entry.currency, currency, entry.date))).then(
    arrayInBaseCurrency => {
      return arrayInBaseCurrency.reduce((accumulator, amount) => accumulator + amount, 0);
    },
  );
}
