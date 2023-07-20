import {
  GraphQLBoolean,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { TierType } from '../../../models/Tier.js';
import { GraphQLTierAmountType, GraphQLTierType as GraphQLTierType } from '../enum/index.js';
import { GraphQLTierFrequency, TierFrequencyKey } from '../enum/TierFrequency.js';

import { AmountInputType, GraphQLAmountInput } from './AmountInput.js';

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

export const GraphQLTierCreateInput = new GraphQLInputObjectType({
  name: 'TierCreateInput',
  fields: () => ({
    amount: {
      type: GraphQLAmountInput,
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
      type: GraphQLAmountInput,
    },
    type: {
      type: new GraphQLNonNull(GraphQLTierType),
    },
    amountType: {
      type: new GraphQLNonNull(GraphQLTierAmountType),
    },
    frequency: {
      type: new GraphQLNonNull(GraphQLTierFrequency),
    },
    presets: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLInt)),
    },
    maxQuantity: {
      type: GraphQLInt,
    },
    minimumAmount: {
      type: GraphQLAmountInput,
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
