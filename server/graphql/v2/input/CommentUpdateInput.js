import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

/**
 * Input type to use as the type for the comment input in editComment mutation.
 */
export const GraphQLCommentUpdateInput = new GraphQLInputObjectType({
  name: 'CommentUpdateInput',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
    html: { type: GraphQLString },
  }),
});
