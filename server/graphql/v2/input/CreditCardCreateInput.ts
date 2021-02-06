import { GraphQLInputObjectType, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';

export const CreditCardCreateInput = new GraphQLInputObjectType({
  name: 'CreditCardCreateInput',
  fields: () => ({
    token: { type: new GraphQLNonNull(GraphQLString) },
    brand: { type: new GraphQLNonNull(GraphQLString) },
    country: { type: new GraphQLNonNull(GraphQLString) },
    expMonth: { type: new GraphQLNonNull(GraphQLInt) },
    expYear: { type: new GraphQLNonNull(GraphQLInt) },
    fullName: { type: GraphQLString },
    funding: { type: GraphQLString },
    zip: { type: GraphQLString },
  }),
});
