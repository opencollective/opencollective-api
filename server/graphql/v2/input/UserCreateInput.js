import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

export const UserCreateInput = new GraphQLInputObjectType({
  name: 'UserCreateInput',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    email: { type: new GraphQLNonNull(GraphQLString) },
  }),
});
