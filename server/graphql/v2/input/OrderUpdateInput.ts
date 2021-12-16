import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

export const OrderUpdateInput = new GraphQLInputObjectType({
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
      type: GraphQLInt,
      description: 'Amount received by collective, excluding any tips or fees, in order currency in cents',
    },
    paymentProcessorFee: {
      type: GraphQLInt,
      description: 'Amount paid in fees for the payment processor in order currency in cents',
    },
    platformTip: {
      type: GraphQLInt,
      description: 'Amount intended as tip for the platform in order currency in cents',
    },
  }),
});
