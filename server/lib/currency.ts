import Promise from 'bluebird';
import config from 'config';
import debugLib from 'debug';
import { get, has, keys, zipObject } from 'lodash';
import fetch from 'node-fetch';

import { currencyFormats } from '../constants/currencies';
import models from '../models';

import cache from './cache';
import logger from './logger';

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
  let isInverted = false;

  // All rates are currently stored with from=USD, so we need to reverse from/to when converting EUR to USD
  if (fromCurrency !== 'USD') {
    if (toCurrencies.length > 1 || toCurrencies[0] !== 'USD') {
      // Can only convert *currency* -> USD at the moment (so we don't support multiple targets)
      logger.warn(
        `getRatesFromDb: Tried to convert ${fromCurrency} to ${toCurrencies.join(', ')}, which is not supported `,
      );
      throw new Error(
        'We are not able to fetch some currencies FX rate at the moment, some statistics may be unavailable',
      );
    } else {
      isInverted = true;
    }
  }

  // Fetch rates
  const [from, to] = isInverted ? [toCurrencies[0], [fromCurrency]] : [fromCurrency, toCurrencies];
  const allRates = await models.CurrencyExchangeRate.getMany(from, to, date);
  const result = {};
  if (isInverted) {
    allRates.forEach(rate => (result[from] = 1 / rate.rate));
  } else {
    allRates.forEach(rate => (result[rate.to] = rate.rate));
  }

  // Make sure we got all currencies
  if (!toCurrencies.every(currency => has(result, currency))) {
    throw new Error(
      'We are not able to fetch the currency FX rates for some currencies at the moment, some statistics may be unavailable',
    );
  }

  return result;
};

export async function fetchFxRates(
  fromCurrency: string,
  toCurrencies: string[],
  date: string | Date = 'latest',
): Promise<Record<string, number>> {
  date = getDate(date);

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
    if (!config.env || !['staging', 'production'].includes(config.env)) {
      logger.info(`Unable to fetch fxRate with Fixer API: ${error.message}. Returning 1.1`);
      return zipObject(
        toCurrencies,
        toCurrencies.map(() => 1.1),
      );
    } else {
      logger.error(`Unable to fetch fxRate with Fixer API: ${error.message}`);
      return getRatesFromDb(fromCurrency, toCurrencies, date);
    }
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

export function convertToCurrency(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  date: string | Date = 'latest',
): Promise<number> {
  if (amount === 0) {
    return 0;
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
  return Promise.map(array, entry => convertToCurrency(entry.amount, entry.currency, currency, entry.date)).then(
    arrayInBaseCurrency => {
      return arrayInBaseCurrency.reduce((accumulator, amount) => accumulator + amount, 0);
    },
  );
}
