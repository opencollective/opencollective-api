import { GraphQLFloat, GraphQLInputObjectType, GraphQLInt } from 'graphql';

import { Currency } from '../enum/Currency';

export const AmountInput = new GraphQLInputObjectType({
  name: 'AmountInput',
  description: 'Input type for an amount with the value and currency',
  fields: () => ({
    value: {
      type: GraphQLFloat,
      description: 'The value in plain',
    },
    currency: {
      type: Currency,
      description: 'The currency string',
    },
    valueInCents: {
      type: GraphQLInt,
      description: 'The value in cents',
    },
  }),
});
