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
    amount: {
      type: AmountInput,
      description: 'Amount received by collective, excluding any tips or fees',
    },
    paymentProcessorFee: {
      type: AmountInput,
      description: 'Amount paid in fees for the payment processor',
    },
    platformTip: {
      type: AmountInput,
      description: 'Amount intended as tip for the platform',
    },
  }),
});
