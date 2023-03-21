import { GraphQLFloat, GraphQLObjectType } from 'graphql';
import { isNil } from 'lodash';

// import { isPromise } from '../../../lib/utils';
import { Currency } from '../enum/Currency';

import CurrencyExchangeRate from './CurrencyExchangeRate';

export const Amount = new GraphQLObjectType({
  name: 'Amount',
  description: 'A financial amount.',
  fields: () => ({
    value: {
      type: GraphQLFloat,
      async resolve(amount) {
        // const value = isPromise(amount.value) ? await amount.value : amount.value;
        const value = amount.value;
        if (isNil(value)) {
          return null;
        } else {
          return parseInt(value, 10) / 100;
        }
      },
    },
    currency: {
      type: Currency,
      resolve(amount) {
        return amount.currency;
      },
    },
    valueInCents: {
      type: GraphQLFloat,
      async resolve(amount) {
        // const value = isPromise(amount.value) ? await amount.value : amount.value;
        const value = amount.value;
        if (isNil(value)) {
          return null;
        } else {
          return parseInt(value, 10);
        }
      },
    },
    exchangeRate: {
      type: CurrencyExchangeRate,
      description:
        'If the amount was generated from a currency conversion, this field contains details about the conversion',
    },
  }),
});
