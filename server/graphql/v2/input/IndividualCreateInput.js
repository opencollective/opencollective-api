import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

export const IndividualCreateInput = new GraphQLInputObjectType({
  name: 'IndividualCreateInput',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    email: { type: new GraphQLNonNull(GraphQLString) },
  }),
});
