import { GraphQLInputObjectType } from 'graphql';

import { AmountInput } from './AmountInput';

export const OrderDetailsInput = new GraphQLInputObjectType({
  name: 'OrderDetailsInput',
  description: 'Input to set amount details received by the host',
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
