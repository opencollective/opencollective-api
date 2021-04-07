import { GraphQLBoolean, GraphQLEnumType, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import GraphQLJSON from 'graphql-type-json';

const BraintreePaymentInputType = new GraphQLEnumType({
  name: 'BraintreePaymentInputType',
  description: 'Type of account used to pay with Braintree',
  values: {
    PayPalAccount: {},
  },
});

export const BraintreePaymentInput = new GraphQLInputObjectType({
  name: 'BraintreePaymentInput',
  fields: () => ({
    nonce: { type: new GraphQLNonNull(GraphQLString) },
    type: { type: new GraphQLNonNull(BraintreePaymentInputType) },
    details: { type: GraphQLJSON },
    binData: { type: GraphQLJSON },
    deviceData: { type: GraphQLJSON },
    description: { type: GraphQLString },
    vaulted: { type: GraphQLBoolean },
  }),
});
