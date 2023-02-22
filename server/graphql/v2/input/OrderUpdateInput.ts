import { GraphQLFloat, GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLAmountInput } from './AmountInput';
import { GraphQLTaxInput } from './TaxInput';

export const GraphQLOrderUpdateInput = new GraphQLInputObjectType({
  name: 'OrderUpdateInput',
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
      type: GraphQLAmountInput,
      description: 'Amount received by collective, excluding any tips, taxes or fees',
    },
    tax: {
      type: GraphQLTaxInput,
      description: 'The tax to apply to the order',
    },
    paymentProcessorFee: {
      type: GraphQLAmountInput,
      description: 'Amount paid in fees for the payment processor',
    },
    platformTip: {
      type: GraphQLAmountInput,
      description: 'Amount intended as tip for the platform',
    },
    hostFeePercent: {
      type: GraphQLFloat,
      description: 'Host fee percent to be applied to the order',
    },
    processedAt: {
      type: GraphQLDateTime,
      description: 'Date the funds were received',
    },
  }),
});
