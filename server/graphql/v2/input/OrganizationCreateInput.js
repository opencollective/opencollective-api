import { GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import GraphQLJSON from 'graphql-type-json';

export const OrganizationCreateInput = new GraphQLInputObjectType({
  name: 'OrganizationCreateInput',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    slug: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: new GraphQLNonNull(GraphQLString) },
    website: { type: GraphQLString },
    settings: { type: GraphQLJSON },
  }),
});
