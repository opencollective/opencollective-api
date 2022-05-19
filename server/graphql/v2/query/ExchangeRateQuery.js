import { GraphQLNonNull, GraphQLString } from 'graphql';

import { getExchangeRate } from '../../../lib/currency';
import { Currency } from '../enum';

const ExchangeRateQuery = {
  type: GraphQLString,
  args: {
    fromCurrency: {
      type: new GraphQLNonNull(Currency),
      description: 'Currency from which to convert. Example: USD, CAD, BTC',
    },
    toCurrency: {
      type: new GraphQLNonNull(Currency),
      description: 'Currency to which the fromCurrency should be converted. Example: USD, CAD, BTC',
    },
  },
  async resolve(_, args) {
    return getExchangeRate(args.fromCurrency, args.toCurrency);
  },
};

export default ExchangeRateQuery;
