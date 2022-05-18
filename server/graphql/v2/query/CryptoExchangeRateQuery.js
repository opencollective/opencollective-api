import { GraphQLNonNull, GraphQLString } from 'graphql';

import { cryptoExchangeRateQuery } from '../../../lib/currency';
import { Currency } from '../enum';
import { CryptoCurrency } from '../enum/Currency';

const CryptoExchangeRateQuery = {
  type: GraphQLString,
  args: {
    cryptoCurrency: {
      type: new GraphQLNonNull(CryptoCurrency),
      description: 'Crypto currency symbol. Example: BTC',
    },
    collectiveCurrency: {
      type: new GraphQLNonNull(Currency),
      description: 'Fiat currency symbol. Example: USD',
    },
  },
  async resolve(_, args) {
    return cryptoExchangeRateQuery(args.cryptoCurrency, args.collectiveCurrency);
  },
};

export default CryptoExchangeRateQuery;
