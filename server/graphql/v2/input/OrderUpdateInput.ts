import { GraphQLInputObjectType } from 'graphql';

import { AmountInput } from './AmountInput';

export const OrderUpdateInput = new GraphQLInputObjectType({
  name: 'OrderUpdateInput',
  fields: () => ({
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
