import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import GraphQLJSON from 'graphql-type-json';

export const PaypalPaymentInput = new GraphQLInputObjectType({
  name: 'PaypalPaymentInput',
  fields: () => ({
    token: { type: new GraphQLNonNull(GraphQLString) },
    data: { type: GraphQLJSON },
  }),
});
