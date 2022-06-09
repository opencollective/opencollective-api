import { GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-type-json';

export const CollectiveCreateInput = new GraphQLInputObjectType({
  name: 'CollectiveCreateInput',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    slug: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: new GraphQLNonNull(GraphQLString) },
    tags: { type: new GraphQLList(GraphQLString) },
    githubHandle: { type: GraphQLString, deprecationReason: '2022-06-03: Please use repositoryUrl' },
    repositoryUrl: { type: GraphQLString },
    settings: { type: GraphQLJSON },
  }),
});
