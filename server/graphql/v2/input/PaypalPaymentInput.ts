import { GraphQLBoolean, GraphQLInputObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-type-json';

export const PaypalPaymentInput = new GraphQLInputObjectType({
  name: 'PaypalPaymentInput',
  fields: () => ({
    token: { type: GraphQLString },
    data: { type: GraphQLJSON },
    orderId: { type: GraphQLString },
    subscriptionId: { type: GraphQLString },
    isNewApi: { type: GraphQLBoolean, deprecationReason: '2021-07-30: Not used anymore' },
  }),
});
