import { GraphQLInputFieldConfig, GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { GraphQLContributionFrequency } from '../enum';
import { GraphQLContributionFrequencyType } from '../enum/ContributionFrequency';

import { AccountReferenceInput, GraphQLAccountReferenceInput } from './AccountReferenceInput';
import { AmountInputType, GraphQLAmountInput } from './AmountInput';

export type GraphQLStripePaymentIntentInputFields = {
  amount: AmountInputType;
  fromAccount: AccountReferenceInput;
  toAccount: AccountReferenceInput;
  frequency: GraphQLContributionFrequencyType;
};

const getFields = () =>
  ({
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
  }) satisfies Record<keyof GraphQLStripePaymentIntentInputFields, GraphQLInputFieldConfig>;

const GraphQLStripePaymentIntentInput = new GraphQLInputObjectType({
  name: 'StripePaymentIntentInput',
  description: 'Input to create a Stripe payment intent',
  fields: getFields,
});

export default GraphQLStripePaymentIntentInput;
