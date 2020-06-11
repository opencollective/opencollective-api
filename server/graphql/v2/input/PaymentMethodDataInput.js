import { GraphQLInputObjectType, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';

export const PaymentMethodDataInput = new GraphQLInputObjectType({
  name: 'PaymentMethodDataInput',
  fields: () => ({
    brand: { type: new GraphQLNonNull(GraphQLString) },
    country: { type: new GraphQLNonNull(GraphQLString) },
    expMonth: { type: new GraphQLNonNull(GraphQLInt) },
    expYear: { type: new GraphQLNonNull(GraphQLInt) },
    fullName: { type: GraphQLString },
    funding: { type: GraphQLString },
    zip: { type: GraphQLString },
  }),
});
