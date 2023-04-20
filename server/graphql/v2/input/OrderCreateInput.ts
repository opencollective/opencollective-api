import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';

import { ContributionFrequency } from '../enum';

import { AccountReferenceInput } from './AccountReferenceInput';
import { AmountInput } from './AmountInput';
import { GuestInfoInput } from './GuestInfoInput';
import { LocationInput } from './LocationInput';
import { OrderTaxInput } from './OrderTaxInput';
import { PaymentMethodInput } from './PaymentMethodInput';
import { GraphQLTaxInput } from './TaxInput';
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

const OrderFromAccountInfo = new GraphQLInputObjectType({
  name: 'OrderFromAccountInfo',
  description: 'Some context about how an order was created',
  fields: () => ({
    location: {
      type: LocationInput,
      description:
        'The location of the contributor. Account location will be updated with this address if different from the existing one.',
    },
    name: {
      type: GraphQLString,
    },
    email: {
      type: GraphQLString,
    },
    legalName: {
      type: GraphQLString,
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
    fromAccountInfo: {
      type: OrderFromAccountInfo,
      description: 'Additional information about the contributing profile',
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
    platformTipAmount: {
      type: AmountInput,
      description: 'Platform tip attached to this order',
    },
    tax: {
      type: GraphQLTaxInput,
      description: 'The tax to apply to the order',
    },
    taxes: {
      type: new GraphQLList(OrderTaxInput),
      description: 'Use this field to set the taxes associated to this order',
      deprecationReason: '2023-04-11: Please use `tax` instead',
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

export const PendingOrderCreateInput = new GraphQLInputObjectType({
  name: 'PendingOrderCreateInput',
  description: 'Input to create a new pending order',
  fields: () => ({
    amount: {
      type: new GraphQLNonNull(AmountInput),
      description: 'The contribution amount, without platform contribution and taxes',
    },
    fromAccount: {
      type: new GraphQLNonNull(AccountReferenceInput),
      description: 'The profile making the contribution.',
    },
    fromAccountInfo: {
      type: OrderFromAccountInfo,
      description: 'Additional information about the contributing profile',
    },
    toAccount: {
      type: new GraphQLNonNull(AccountReferenceInput),
      description: 'The collective you want to contribute to',
    },
    tax: {
      type: GraphQLTaxInput,
      description: 'The tax to apply to the order',
    },
    tier: {
      type: TierReferenceInput,
      description: 'The tier you are contributing to',
    },
    description: {
      type: GraphQLString,
      description: 'Public order description',
    },
    memo: {
      type: GraphQLString,
      description: 'Private memo for the host',
    },
    ponumber: {
      type: GraphQLString,
      description: 'External identifier for the order',
    },
    paymentMethod: {
      type: GraphQLString, // TODO: Should be a GraphQLEnum. Also maybe rename to `paymentMethodType`?
      description: 'Payment method expected for this order',
    },
    expectedAt: {
      type: GraphQLDateTime,
      description: 'When is the money expected?',
    },
    hostFeePercent: {
      type: GraphQLFloat,
      description: 'Custom Host fee percent for this order',
    },
  }),
});

export const PendingOrderEditInput = new GraphQLInputObjectType({
  name: 'PendingOrderEditInput',
  description: 'Input to edit an existing pending order',
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
      type: new GraphQLNonNull(AmountInput),
      description: 'The contribution amount, without platform contribution and taxes',
    },
    fromAccount: {
      type: AccountReferenceInput,
      description: 'The profile making the contribution.',
    },
    fromAccountInfo: {
      type: OrderFromAccountInfo,
      description: 'Additional information about the contributing profile',
    },
    tax: {
      type: GraphQLTaxInput,
      description: 'The tax to apply to the order',
    },
    tier: {
      type: TierReferenceInput,
      description: 'The tier you are contributing to',
    },
    description: {
      type: GraphQLString,
      description: 'Public order description',
    },
    memo: {
      type: GraphQLString,
      description: 'Private memo for the host',
    },
    ponumber: {
      type: GraphQLString,
      description: 'External identifier for the order',
    },
    paymentMethod: {
      type: GraphQLString, // TODO: Should be a GraphQLEnum. Also maybe rename to `paymentMethodType`?
      description: 'Payment method expected for this order',
    },
    expectedAt: {
      type: GraphQLDateTime,
      description: 'When is the money expected?',
    },
    hostFeePercent: {
      type: GraphQLFloat,
      description: 'Custom Host fee percent for this order',
    },
  }),
});
