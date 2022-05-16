import { GraphQLNonNull, GraphQLString } from 'graphql';

import { getCryptoFxRate } from '../../../lib/currency';

const CryptoExchangeRateQuery = {
  type: GraphQLString,
  args: {
    cryptoCurrency: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Crypto currency symbol. Example: BTC',
    },
    collectiveCurrency: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Fiat currency symbol. Example: USD',
    },
  },
  async resolve(_, args) {
    return getCryptoFxRate(args.cryptoCurrency, args.collectiveCurrency);
  },
};

export default CryptoExchangeRateQuery;
