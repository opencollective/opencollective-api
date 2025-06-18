import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

export const GraphQLIndividualCreateInput = new GraphQLInputObjectType({
  name: 'IndividualCreateInput',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    legalName: { type: GraphQLString },
    email: { type: new GraphQLNonNull(GraphQLString) },
    password: { type: GraphQLString },
  }),
});
