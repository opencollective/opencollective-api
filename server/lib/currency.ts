import Promise from 'bluebird';
import config from 'config';
import debugLib from 'debug';
import { get, keys, zipObject } from 'lodash';
import fetch from 'node-fetch';

import { currencyFormats } from '../constants/currencies';

import logger from './logger';

const debug = debugLib('currency');
const cache = {};

function getDate(date: string | Date = 'latest') {
  if (typeof date == 'string') {
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

export async function fetchFxRates(
  fromCurrency: string,
  toCurrencies: string[],
  date: string | Date = 'latest',
): Promise<Record<string, number>> {
  date = getDate(date);
  let dateKey = date;
  if (dateKey === 'latest') {
    dateKey = getDate(new Date());
  }

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
      cache[`${dateKey}-${fromCurrency}-${to}`] = rates[to];
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
      throw error;
    }
  }
}

export async function getFxRate(
  fromCurrency: string,
  toCurrency: string,
  date: string | Date = 'latest',
): Promise<number> {
  debug(`getFxRate for ${date} ${fromCurrency} -> ${toCurrency}`);

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
  let dateKey = date;
  if (dateKey === 'latest') {
    dateKey = getDate(new Date());
  }

  const key = `${dateKey}-${fromCurrency}-${toCurrency}`;
  if (cache[key]) {
    return cache[key];
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

/**
 * The goal of this function is to return the sum of an array of { currency, amount, date }
 * to one total amount in the given currency
 * @param {*} array [ { currency, amount[, date] }]
 */
export function reduceArrayToCurrency(array, currency) {
  return Promise.map(array, entry => convertToCurrency(entry.amount, entry.currency, currency, entry.date)).then(
    arrayInBaseCurrency => {
      return arrayInBaseCurrency.reduce((accumulator, amount) => accumulator + amount, 0);
    },
  );
}
