import { GraphQLFloat, GraphQLObjectType } from 'graphql';
import { isNil } from 'lodash';

import { GraphQLCurrency } from '../enum/Currency';

import GraphQLCurrencyExchangeRate from './CurrencyExchangeRate';

export const GraphQLAmount = new GraphQLObjectType({
  name: 'Amount',
  description: 'A financial amount.',
  fields: () => ({
    value: {
      type: GraphQLFloat,
      resolve(amount) {
        if (isNil(amount.value)) {
          return null;
        } else {
          return parseInt(amount.value, 10) / 100;
        }
      },
    },
    currency: {
      type: GraphQLCurrency,
      resolve(amount) {
        return amount.currency;
      },
    },
    valueInCents: {
      type: GraphQLFloat,
      resolve(amount) {
        if (isNil(amount.value)) {
          return null;
        } else {
          return parseInt(amount.value, 10);
        }
      },
    },
    exchangeRate: {
      type: GraphQLCurrencyExchangeRate,
      description:
        'If the amount was generated from a currency conversion, this field contains details about the conversion',
    },
  }),
});
