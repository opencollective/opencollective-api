import { GraphQLInputObjectType, GraphQLInt } from 'graphql';

export const PaymentMethodReferenceInput = new GraphQLInputObjectType({
  name: 'PaymentMethodReferenceInput',
  fields: () => ({
    legacyId: {
      type: GraphQLInt,
      description: 'The legacy id assigned to the payment method',
    },
  }),
});
