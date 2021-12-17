import {
  GraphQLBoolean,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { GraphQLJSON } from 'graphql-type-json';

import { ContributionFrequency } from '../enum';

import { AccountReferenceInput } from './AccountReferenceInput';
import { AmountInput } from './AmountInput';
import { GuestInfoInput } from './GuestInfoInput';
import { OrderTaxInput } from './OrderTaxInput';
import { PaymentMethodInput } from './PaymentMethodInput';
import { TierReferenceInput } from './TierReferenceInput';

const OrderContextInput = new GraphQLInputObjectType({
  name: 'OrderContextInput',
  description: 'Some context about how an order was created',
  fields: () => ({
    isEmbed: {
      type: GraphQLBoolean,
      description: 'Whether this order was created using the embedded contribution flow',
    },
  }),
});

export const OrderCreateInput = new GraphQLInputObjectType({
  name: 'OrderCreateInput',
  description: 'Input to create a new order',
  fields: () => ({
    quantity: {
      type: new GraphQLNonNull(GraphQLInt),
      defaultValue: 1,
    },
    amount: {
      type: new GraphQLNonNull(AmountInput),
      description: 'The contribution amount for 1 quantity, without platform contribution and taxes',
    },
    frequency: {
      type: new GraphQLNonNull(ContributionFrequency),
    },
    fromAccount: {
      type: AccountReferenceInput,
      description: 'The profile making the order. Can be null for guest contributions.',
    },
    toAccount: {
      type: new GraphQLNonNull(AccountReferenceInput),
      description: 'The profile you want to contribute to',
    },
    guestInfo: {
      type: GuestInfoInput,
      description: 'Use this when fromAccount is null to pass the guest info',
    },
    paymentMethod: {
      description: 'The payment method used for this order',
      type: PaymentMethodInput,
    },
    platformContributionAmount: {
      type: AmountInput,
      description: 'Platform contribution attached to this order',
      deprecationReason: '2021-12-17: Use platformTipAmount',
    },
    platformTipAmount: {
      type: AmountInput,
      description: 'Platform tip attached to this order',
    },
    taxes: {
      type: new GraphQLList(OrderTaxInput),
      description: 'Use this field to set the taxes associated to this order',
    },
    tier: {
      type: TierReferenceInput,
      description: 'The tier you are contributing to',
    },
    data: {
      type: GraphQLJSON,
      description: 'Data related to this order',
    },
    customData: {
      type: GraphQLJSON,
      description: 'If the tier has some "customFields", use this field to set their values',
    },
    context: {
      type: OrderContextInput,
      description: 'Some context about how this order was created',
    },
    isBalanceTransfer: {
      type: GraphQLBoolean,
      description: 'Whether this is transferring the remaining balance from a project/event/collective',
    },
    tags: {
      type: new GraphQLList(GraphQLString),
      description: 'Tags associated to the order',
    },
  }),
});
