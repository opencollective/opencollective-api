import { GraphQLBoolean, GraphQLFloat, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { Currency } from '../enum';
import { CurrencyFxRateSourceType } from '../enum/CurrencyFxRateSourceType';

const CurrencyFxRate = new GraphQLObjectType({
  name: 'CurrencyFxRate',
  description: 'Fields for a currency fx rate',
  fields: () => ({
    value: {
      type: new GraphQLNonNull(GraphQLFloat),
      description: 'Exchange rate value as a percentage',
    },
    source: {
      type: new GraphQLNonNull(CurrencyFxRateSourceType),
      description: 'Where does the FX rate comes from',
    },
    fromCurrency: {
      type: new GraphQLNonNull(Currency),
    },
    toCurrency: {
      type: new GraphQLNonNull(Currency),
    },
    date: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'Date of the FX rate',
    },
    isApproximate: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Is the FX rate approximate or a fixed value?',
    },
  }),
});

export default CurrencyFxRate;
