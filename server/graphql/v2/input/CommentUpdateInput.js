import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

/**
 * Input type to use as the type for the comment input in editComment mutation.
 */
export const CommentUpdateInput = new GraphQLInputObjectType({
  name: 'CommentUpdateInput',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
    markdown: { type: GraphQLString, deprecationReason: '2021-01-25: Please use html' },
    html: { type: GraphQLString },
  }),
});
