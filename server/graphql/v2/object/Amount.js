import { GraphQLFloat, GraphQLInt, GraphQLObjectType } from 'graphql';
import { isNil } from 'lodash';

import { Currency } from '../enum/Currency';

export const Amount = new GraphQLObjectType({
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
      type: Currency,
      resolve(amount) {
        return amount.currency;
      },
    },
    valueInCents: {
      type: GraphQLInt,
      resolve(amount) {
        if (isNil(amount.value)) {
          return null;
        } else {
          return parseInt(amount.value, 10);
        }
      },
    },
  }),
});
