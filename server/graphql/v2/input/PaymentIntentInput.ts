import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { GraphQLAccountReferenceInput } from './AccountReferenceInput.js';
import { GraphQLAmountInput } from './AmountInput.js';

const GraphQLPaymentIntentInput = new GraphQLInputObjectType({
  name: 'PaymentIntentInput',
  description: 'Input to create a Stripe payment intent',
  fields: () => {
    return {
      amount: {
        type: new GraphQLNonNull(GraphQLAmountInput),
      },
      fromAccount: {
        type: GraphQLAccountReferenceInput,
      },
      toAccount: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      },
    };
  },
});

export default GraphQLPaymentIntentInput;
