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

export const TierCreateInput = new GraphQLInputObjectType({
  name: 'TierCreateInput',
  fields: () => ({
    amount: {
      type: new GraphQLNonNull(AmountInput),
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
  }),
});
