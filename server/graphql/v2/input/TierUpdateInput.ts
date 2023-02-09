import {
  GraphQLBoolean,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { TierAmountType, TierType } from '../enum';
import { TierFrequency } from '../enum/TierFrequency';

import { AmountInput } from './AmountInput';

export const TierUpdateInput = new GraphQLInputObjectType({
  name: 'TierUpdateInput',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The public id identifying the tier (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
    amount: {
      type: AmountInput,
    },
    name: {
      type: GraphQLNonEmptyString,
    },
    description: {
      type: GraphQLString,
    },
    button: {
      type: GraphQLString,
    },
    goal: {
      type: AmountInput,
    },
    type: {
      type: new GraphQLNonNull(TierType),
    },
    amountType: {
      type: new GraphQLNonNull(TierAmountType),
    },
    frequency: {
      type: new GraphQLNonNull(TierFrequency),
    },
    presets: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLInt)),
    },
    maxQuantity: {
      type: GraphQLInt,
    },
    minimumAmount: {
      type: AmountInput,
    },
    useStandalonePage: {
      type: GraphQLBoolean,
    },
    invoiceTemplate: {
      type: GraphQLString,
    },
    singleTicket: {
      type: GraphQLBoolean,
    },
  }),
});
