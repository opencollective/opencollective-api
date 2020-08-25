import { GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

export const AccountUpdateInput = new GraphQLInputObjectType({
  name: 'AccountUpdateInput',
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'ID of the account that you want to edit',
    },
    name: {
      type: GraphQLString,
      description: 'Name of the account',
    },
    company: {
      type: GraphQLString,
    },
    description: {
      type: GraphQLString,
    },
    longDescription: {
      type: GraphQLString,
    },
    twitterHandle: {
      type: GraphQLString,
    },
    githubHandle: {
      type: GraphQLString,
    },
    website: {
      type: GraphQLString,
    },
    tags: {
      type: new GraphQLList(GraphQLString),
    },
  },
});
