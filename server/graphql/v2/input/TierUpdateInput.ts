import {
  GraphQLBoolean,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { Tier } from '../../../models';
import { GraphQLTierAmountType, GraphQLTierType } from '../enum';
import { GraphQLTierFrequency } from '../enum/TierFrequency';
import GraphQLURL from '../scalar/URL';

import { GraphQLAmountInput } from './AmountInput';
import { TierCreateInputFields } from './TierCreateInput';

export type TierUpdateInputFields = { id: string } & Partial<TierCreateInputFields>;

export const GraphQLTierUpdateInput = new GraphQLInputObjectType({
  name: 'TierUpdateInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The public id identifying the tier (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
      deprecationReason: '2026-02-25: use publicId',
    },
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${Tier.nanoIdPrefix}_xxxxxxxx)`,
    },
    amount: {
      type: GraphQLAmountInput,
    },
    name: {
      type: GraphQLNonEmptyString,
    },
    description: {
      type: GraphQLString,
    },
    longDescription: {
      type: GraphQLString,
    },
    videoUrl: {
      type: GraphQLURL,
    },
    button: {
      type: GraphQLString,
    },
    goal: {
      type: GraphQLAmountInput,
    },
    type: {
      type: GraphQLTierType,
    },
    amountType: {
      type: GraphQLTierAmountType,
    },
    frequency: {
      type: GraphQLTierFrequency,
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
