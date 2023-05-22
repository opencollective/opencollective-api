import DataLoader from 'dataloader';
import { groupBy, mapValues, uniq } from 'lodash';

import { getFxRates } from '../../lib/currency';

interface CurrencyFxRateRequest {
  fromCurrency: string;
  toCurrency: string;
}

/**
 * Group requests by `fromCurrency`, since fx rate APIs support having multiple `toCurrency`.
 */
export const loadFxRatesMap = async (
  requests: CurrencyFxRateRequest[],
): Promise<Record<string, Record<string, number>>> => {
  // The goal here is to convert a list of requests like this:
  // [{ from: 'USD', to: 'EUR' }, { from: 'USD', to: 'GBP' }, { from: 'EUR', to: 'GBP' }]
  // To a map like this:
  // { USD: ['EUR', 'GBP'], EUR: ['GBP'] }
  const groupedRequests = groupBy(requests, 'fromCurrency');
  const conversionsMap = mapValues(groupedRequests, requests => {
    return uniq(requests.map(request => request.toCurrency));
  });

  // Fetch FX rates to get a map like:
  // { USD: { EUR: 0.8, GBP: 0.5 }, EUR: { GBP: 0.5 } }
  const result: Record<string, Record<string, number>> = {};
  for (const key of Object.keys(conversionsMap)) {
    const value = conversionsMap[key];
    result[key] = await getFxRates(key, value);
  }
  return result;
};

export const generateFxRateLoader = (): DataLoader<CurrencyFxRateRequest, number> => {
  return new DataLoader(
    async (requestedCurrencies: CurrencyFxRateRequest[]) => {
      const fxRates = await loadFxRatesMap(requestedCurrencies);
      return requestedCurrencies.map(request => fxRates[request.fromCurrency][request.toCurrency]);
    },
    {
      // Since the argument is an object, we need a custom serializer to be able to use it in the cache
      cacheKeyFn: arg => `${arg.fromCurrency}-${arg.toCurrency}`,
    },
  );
};

type ConvertToCurrencyArgs = {
  amount: number;
  fromCurrency: string;
  toCurrency: string;
};

export const generateConvertToCurrencyLoader = (): DataLoader<ConvertToCurrencyArgs, number> => {
  return new DataLoader(
    async (requestedConversions: ConvertToCurrencyArgs[]) => {
      const fxRates = await loadFxRatesMap(requestedConversions);
      return requestedConversions.map(request => {
        return Math.round(fxRates[request.fromCurrency][request.toCurrency] * request.amount);
      });
    },
    {
      // Since the argument is an object, we need a custom serializer to be able to use it in the cache
      cacheKeyFn: arg => `${arg.amount}-${arg.fromCurrency}-${arg.toCurrency}`,
    },
  );
};
