import { GraphQLFloat, GraphQLObjectType } from 'graphql';

import { Currency } from '../enum/Currency';

export const AmountInput = new GraphQLObjectType({
  name: 'AmountInput',
  fields: () => ({
    value: {
      type: GraphQLFloat,
      description: 'The value in plain',
    },
    currency: {
      type: Currency,
      description: 'The currency string',
    },
  }),
});
