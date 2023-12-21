import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLCurrency } from '../enum';

export const GraphQLCurrencyExchangeRateRequest = new GraphQLInputObjectType({
  name: 'CurrencyExchangeRateRequest',
  description: 'Request for a currency exchange rate',
  fields: () => ({
    fromCurrency: {
      type: new GraphQLNonNull(GraphQLCurrency),
      description: 'Currency to convert from',
    },
    toCurrency: {
      type: new GraphQLNonNull(GraphQLCurrency),
      description: 'Currency to convert to',
    },
    date: {
      type: GraphQLDateTime,
      description: 'Date of the exchange rate. Defaults to now.',
    },
  }),
});
