import {
  GraphQLBoolean,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { TierType } from '../../../models/Tier';
import { TierAmountType, TierType as GraphQLTierType } from '../enum';
import { TierFrequency, TierFrequencyKey } from '../enum/TierFrequency';

import { AmountInput, AmountInputType } from './AmountInput';

export type TierCreateInputFields = {
  amount?: AmountInputType;
  name?: string;
  description?: string;
  button?: string;
  goal?: AmountInputType;
  type: TierType;
  amountType: 'FLEXIBLE' | 'FIXED';
  frequency: TierFrequencyKey;
  presets?: number[];
  maxQuantity?: number;
  minimumAmount?: AmountInputType;
  useStandalonePage?: boolean;
  invoiceTemplate?: string;
  singleTicket?: boolean;
};

export const TierCreateInput = new GraphQLInputObjectType({
  name: 'TierCreateInput',
  fields: () => ({
    amount: {
      type: AmountInput,
    },
    name: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
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
      type: new GraphQLNonNull(GraphQLTierType),
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
