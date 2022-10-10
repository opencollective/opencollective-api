import { GraphQLInputObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-type-json';

export const PaypalPaymentInput = new GraphQLInputObjectType({
  name: 'PaypalPaymentInput',
  fields: () => ({
    token: { type: GraphQLString },
    data: { type: GraphQLJSON },
    orderId: { type: GraphQLString },
    subscriptionId: { type: GraphQLString },
  }),
});
