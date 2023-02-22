import { GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

export const GraphQLProjectCreateInput = new GraphQLInputObjectType({
  name: 'ProjectCreateInput',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    slug: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: new GraphQLNonNull(GraphQLString) },
    tags: { type: new GraphQLList(GraphQLString) },
    settings: { type: GraphQLJSON },
  }),
});
