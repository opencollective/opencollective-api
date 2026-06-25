import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { GraphQLContributionFrequency } from '../enum';

import { GraphQLAccountReferenceInput } from './AccountReferenceInput';
import { GraphQLAmountInput } from './AmountInput';

const getFields = () => ({
  amount: {
    type: new GraphQLNonNull(GraphQLAmountInput),
    description: 'The amount to create a Stripe payment intent for',
  },
  fromAccount: {
    type: GraphQLAccountReferenceInput,
    description: 'The payer account',
  },
  toAccount: {
    type: new GraphQLNonNull(GraphQLAccountReferenceInput),
    description: 'The payee account',
  },
  frequency: {
    type: GraphQLContributionFrequency,
    description: 'The frequency of the contribution',
  },
});

const GraphQLStripePaymentIntentInput = new GraphQLInputObjectType({
  name: 'StripePaymentIntentInput',
  description: 'Input to create a Stripe payment intent',
  fields: getFields,
});

// TODO(#8851): remove this legacy type
export const LegacyGraphQLPaymentIntentInput = new GraphQLInputObjectType({
  name: 'PaymentIntentInput',
  description: 'Input to create a Stripe payment intent (deprecated, use StripePaymentIntentInput)',
  fields: getFields,
});

export default GraphQLStripePaymentIntentInput;
