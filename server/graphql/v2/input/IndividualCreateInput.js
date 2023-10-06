import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

export const GraphQLIndividualCreateInput = new GraphQLInputObjectType({
  name: 'IndividualCreateInput',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    email: { type: new GraphQLNonNull(GraphQLString) },
  }),
});
