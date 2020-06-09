import { GraphQLInputObjectType, GraphQLString } from 'graphql';

export const PaymentMethodReferenceInput = new GraphQLInputObjectType({
  name: 'PaymentMethodReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The encrypted id assigned to the payment method',
    },
  }),
});
