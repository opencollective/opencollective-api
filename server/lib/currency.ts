import config from 'config';
import debugLib from 'debug';
import { difference, get, groupBy, has, keys, mapValues, merge, set, uniq, zipObject } from 'lodash';
import moment from 'moment';
import fetch from 'node-fetch';

import { currencyFormats, SUPPORTED_CURRENCIES, SupportedCurrency } from '../constants/currencies';
import models from '../models';

import cache from './cache';
import logger from './logger';
import { reportErrorToSentry, reportMessageToSentry } from './sentry';
import { parseToBoolean } from './utils';

const debug = debugLib('currency');

/**
 * An helper to get a date key for the FX rate map
 */
export function getDate(date: string | Date = 'latest'): string {
  if (typeof date === 'string') {
    return date;
  } else if (date.getFullYear) {
    return moment(date).format('YYYY-MM-DD');
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

const showFixerWarning = () => {
  if (!get(config, 'fixer.accessKey')) {
    if (['staging', 'production'].includes(config.env) || parseToBoolean(get(config, 'fixer.disableMock'))) {
      const logFn = config.env === 'production' ? logger.warn : logger.info; // In prod, having no Fixer API would be problematic as our FX rates would quickly become outdated
      logFn('Fixer API is not configured, lib/currency will fallback to DB values');
    } else {
      logger.info('Fixer API is not configured, lib/currency will always return 1.1');
    }
  }
};

// Show fixer warning when booting the APP
showFixerWarning();

type ResultCurrencyMap = { [currency in SupportedCurrency]?: number };

export const getRatesFromDb = async (
  fromCurrency: SupportedCurrency,
  toCurrencies: SupportedCurrency[],
  date: string | Date = 'latest',
): Promise<ResultCurrencyMap> => {
  // TODO: This function is a bit messy, refactor it

  const hasOnlyOneCurrency = toCurrencies.length === 1;
  let isInverted = false;
  if (!isSupportedCurrency(fromCurrency)) {
    isInverted = true;
    if (!hasOnlyOneCurrency || !isSupportedCurrency(toCurrencies[0])) {
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
      isSupportedCurrency(toCurrencies[0]) &&
      isSupportedCurrency(fromCurrency)
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
  fromCurrency: SupportedCurrency,
  toCurrencies: SupportedCurrency[],
  date: string | Date = 'latest',
): Promise<ResultCurrencyMap> {
  date = getDate(date);

  const isFutureDate = date !== 'latest' && moment(date).isAfter(moment(), 'day'); // Fixer API is not able to fetch future rates. Ideally, this function should return null when requesting a future date.
  const useFixerApi = Boolean(get(config, 'fixer.accessKey')) && !isFutureDate;
  const isLiveEnv = ['staging', 'production'].includes(config.env);
  const useMockRate = !isLiveEnv && !parseToBoolean(get(config, 'fixer.disableMock'));

  if (!useFixerApi) {
    showFixerWarning();
  } else {
    // Try to fetch the FX rates from fixer.io
    const searchParams = new URLSearchParams();
    searchParams.append('access_key', config.fixer.accessKey);
    searchParams.append('base', fromCurrency);
    searchParams.append('symbols', toCurrencies.join(','));

    try {
      // Fixer doesn't support time
      const simplifiedDate = date === 'latest' ? date : date.split('T')[0];
      const res = await fetch(`https://data.fixer.io/${simplifiedDate}?${searchParams.toString()}`);
      const json = await res.json();
      if (json.error) {
        reportMessageToSentry(`FX Rate query issue: ${json.error.info} (${searchParams.toString()})`);
        throw new Error('We are unable to fetch some currencies FX rate at the moment');
      }
      const rates = {};
      keys(json.rates).forEach(to => {
        rates[to] = parseFloat(json.rates[to]);
        const cacheTtl = date === 'latest' ? 60 * 60 /* 60 minutes */ : null; /* no expiration */
        cache.set(`${date}-${fromCurrency}-${to}`, rates[to], cacheTtl);
      });

      return rates;
    } catch (error) {
      if (useMockRate) {
        logger.info(`Unable to fetch fxRate with Fixer API: ${error.message}. Returning 1.1`);
      } else {
        logger.error(`Unable to fetch fxRate with Fixer API: ${error.message}. Using DB fallback`);
        reportErrorToSentry(error);
      }
    }
  }

  if (useMockRate) {
    const ratesValues = toCurrencies.map(() => 1.1);
    return zipObject(toCurrencies, ratesValues);
  }

  // As a fallback, try to fetch the rates from the DB
  return getRatesFromDb(fromCurrency, toCurrencies, date);
}

export async function getFxRate(
  fromCurrency: SupportedCurrency,
  toCurrency: SupportedCurrency,
  date: string | Date = 'latest',
): Promise<number> {
  debug(`getFxRate for ${date} ${fromCurrency} -> ${toCurrency}`);
  fromCurrency = fromCurrency?.toUpperCase() as SupportedCurrency;
  toCurrency = toCurrency?.toUpperCase() as SupportedCurrency;

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
  fromCurrency: SupportedCurrency,
  toCurrencies: SupportedCurrency[],
  date: string | Date = 'latest',
): Promise<ResultCurrencyMap> {
  fromCurrency = fromCurrency?.toUpperCase() as SupportedCurrency;
  toCurrencies = uniq(toCurrencies.map(c => c.toUpperCase())) as SupportedCurrency[];
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
    const currenciesLeftToFetch = difference(toCurrencies, Object.keys(rates)) as SupportedCurrency[];
    const missingRates = await fetchFxRates(fromCurrency, currenciesLeftToFetch, date);
    return merge(rates, missingRates);
  }
}

export function convertToCurrency(
  amount: number,
  fromCurrency: SupportedCurrency,
  toCurrency: SupportedCurrency,
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
  currency: SupportedCurrency;
  amount: number;
  date: Date | string;
};

/**
 * The goal of this function is to return the sum of an array of { currency, amount, date }
 * to one total amount in the given currency
 * @param {*} array [ { currency, amount[, date] }]
 */
export function reduceArrayToCurrency(
  array: AmountWithCurrencyAndDate[],
  currency: SupportedCurrency,
): Promise<number> {
  return Promise.all(array.map(entry => convertToCurrency(entry.amount, entry.currency, currency, entry.date))).then(
    arrayInBaseCurrency => {
      return arrayInBaseCurrency.reduce((accumulator, amount) => accumulator + amount, 0);
    },
  );
}

export type LoadFxRateRequest = {
  fromCurrency: SupportedCurrency;
  toCurrency: SupportedCurrency;
  date?: string;
};

type LoadFxRateResultMap = {
  [date: string | 'latest']: { [fromCurrency in SupportedCurrency]: { [toCurrency in SupportedCurrency]: number } };
};

export const getDateKeyForFxRateMap = (date: string | Date): 'latest' | string => {
  if (!date) {
    return 'latest';
  } else {
    return getDate(date);
  }
};

/**
 * A function to load multiple FX rates at once, optimized to avoid making too many requests.
 *
 * @returns A map of the form `{ [date]: { [fromCurrency]: { [toCurrency]: fxRate } } }`. When `date` is not set, it defaults to `latest`.
 */
export const loadFxRatesMap = async (requests: Array<LoadFxRateRequest>): Promise<LoadFxRateResultMap> => {
  // Group requests by date: { [date]: requests }
  const requestsByDate = groupBy(requests, request => getDateKeyForFxRateMap(request.date));

  // Group each date's requests by fromCurrency: { [date]: { [fromCurrency]: requests } }
  const groupedByDateAndFromCurrency = mapValues(requestsByDate, requests => groupBy(requests, 'fromCurrency'));

  // Fetch FX rates
  const result: LoadFxRateResultMap = {};
  for (const [dateStr, requestsByCurrency] of Object.entries(groupedByDateAndFromCurrency)) {
    for (const [fromCurrency, requests] of Object.entries(requestsByCurrency)) {
      const toCurrencies = uniq(requests.map(request => request.toCurrency));
      const fxRates = await getFxRates(fromCurrency as SupportedCurrency, toCurrencies, dateStr);
      set(result, [dateStr, fromCurrency], fxRates);
    }
  }

  return result;
};

/**
 * Checks if the given currency satisfies the `SUPPORTED_CURRENCIES` list.
 */
export const isSupportedCurrency = (value: string): boolean => {
  return Boolean(value && SUPPORTED_CURRENCIES.includes(value as SupportedCurrency));
};
