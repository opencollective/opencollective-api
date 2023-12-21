import { GraphQLFloat, GraphQLObjectType } from 'graphql';
import { isNil } from 'lodash';

import { GraphQLCurrency } from '../enum/Currency';

import GraphQLCurrencyExchangeRate, { GraphQLCurrencyExchangeRateFields } from './CurrencyExchangeRate';

/**
 * Describes an amount in a way that can safely be passed to the `Amount` GraphQL type.
 * The amount in cents needs to be set on `value`
 */
export type GraphQLAmountFields = {
  value: number;
  currency: string;
  exchangeRate?: GraphQLCurrencyExchangeRateFields;
};

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
