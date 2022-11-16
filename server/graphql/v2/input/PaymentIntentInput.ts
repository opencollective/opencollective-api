import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { AccountReferenceInput } from './AccountReferenceInput';
import { AmountInput } from './AmountInput';

const PaymentIntentInput = new GraphQLInputObjectType({
  name: 'PaymentIntentInput',
  description: 'Input to create a Stripe payment intent',
  fields: () => {
    return {
      amount: {
        type: new GraphQLNonNull(AmountInput),
      },
      fromAccount: {
        type: AccountReferenceInput,
      },
      toAccount: {
        type: new GraphQLNonNull(AccountReferenceInput),
      },
    };
  },
});

export default PaymentIntentInput;
