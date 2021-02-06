import { GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import GraphQLJSON from 'graphql-type-json';

export const FundCreateInput = new GraphQLInputObjectType({
  name: 'FundCreateInput',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    slug: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: new GraphQLNonNull(GraphQLString) },
    tags: { type: new GraphQLList(GraphQLString) },
    settings: { type: GraphQLJSON },
  }),
});
