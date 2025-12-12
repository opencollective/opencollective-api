import DataLoader from 'dataloader';

import { SupportedCurrency } from '../../constants/currencies';
import { getDateKeyForFxRateMap, loadFxRatesMap } from '../../lib/currency';

interface CurrencyFxRateRequest {
  fromCurrency: SupportedCurrency;
  toCurrency: SupportedCurrency;
  date?: string;
}

export const generateFxRateLoader = (): DataLoader<CurrencyFxRateRequest, number> => {
  return new DataLoader(
    async (requestedCurrencies: CurrencyFxRateRequest[]) => {
      const fxRates = await loadFxRatesMap(requestedCurrencies);
      return requestedCurrencies.map(
        request => fxRates[getDateKeyForFxRateMap(request.date)][request.fromCurrency][request.toCurrency],
      );
    },
    {
      // Since the argument is an object, we need a custom serializer to be able to use it in the cache
      cacheKeyFn: arg => {
        return `${arg.fromCurrency}-${arg.toCurrency}-${getDateKeyForFxRateMap(arg.date)}`;
      },
    },
  );
};

export type ConvertToCurrencyArgs = {
  amount: number;
  fromCurrency: SupportedCurrency;
  toCurrency: SupportedCurrency;
};

export const generateConvertToCurrencyLoader = (): DataLoader<ConvertToCurrencyArgs, number> => {
  return new DataLoader(
    async (requestedConversions: ConvertToCurrencyArgs[]) => {
      const fxRates = await loadFxRatesMap(requestedConversions);
      return requestedConversions.map(request => {
        return Math.round(fxRates['latest'][request.fromCurrency][request.toCurrency] * request.amount);
      });
    },
    {
      // Since the argument is an object, we need a custom serializer to be able to use it in the cache
      cacheKeyFn: arg => `${arg.amount}-${arg.fromCurrency}-${arg.toCurrency}`,
    },
  );
};
