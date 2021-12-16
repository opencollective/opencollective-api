import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import { AmountInput } from './AmountInput';

export const OrderUpdateInput = new GraphQLInputObjectType({
  name: 'OrderUpdateInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The public id identifying the order (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The legacy public id identifying the order (ie: 4242)',
    },
    totalAmount: {
      type: AmountInput,
    },
    paymentProcessorFeesAmount: {
      type: AmountInput,
    },
    platformTipAmount: {
      type: AmountInput,
    },
  }),
});
