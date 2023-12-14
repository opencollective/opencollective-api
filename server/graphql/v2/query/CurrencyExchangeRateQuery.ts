import { GraphQLList, GraphQLNonNull } from 'graphql';

import { loadFxRatesMap } from '../../../lib/currency';
import { GraphQLCurrencyExchangeRateRequest } from '../input/CurrencyExchangeRateRequest';
import GraphQLCurrencyExchangeRate, { GraphQLCurrencyExchangeRateFields } from '../object/CurrencyExchangeRate';

const CurrencyExchangeRateQuery = {
  type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLCurrencyExchangeRate))),
  description: 'Get exchange rates from Open Collective',
  args: {
    requests: {
      description: 'Requests for currency exchange rates',
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLCurrencyExchangeRateRequest))),
    },
  },
  resolve: async (_, args): Promise<GraphQLCurrencyExchangeRateFields[]> => {
    if (!args.requests.length) {
      return [];
    }

    // `loadFxRatesMap` deduplicates requests and returns a map of fx rates
    const fxRates = await loadFxRatesMap(args.requests);
    const ratesList = [];
    const now = new Date();
    for (const [date, allRatesForDate] of Object.entries(fxRates)) {
      for (const [fromCurrency, allRatesForFromCurrency] of Object.entries(allRatesForDate)) {
        for (const [toCurrency, rate] of Object.entries(allRatesForFromCurrency)) {
          ratesList.push({
            value: rate,
            source: 'OPENCOLLECTIVE',
            fromCurrency,
            toCurrency,
            date: date === 'latest' ? now : new Date(date),
            isApproximate: false,
          });
        }
      }
    }

    return ratesList;
  },
};

export default CurrencyExchangeRateQuery;
