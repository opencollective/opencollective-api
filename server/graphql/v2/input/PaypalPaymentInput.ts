import { GraphQLInputObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

export const PaypalPaymentInput = new GraphQLInputObjectType({
  name: 'PaypalPaymentInput',
  fields: () => ({
    token: { type: GraphQLString },
    data: { type: GraphQLJSON },
    orderId: { type: GraphQLString },
    subscriptionId: { type: GraphQLString },
  }),
});
