import { GraphQLInputObjectType, GraphQLString } from 'graphql';

/**
 * An input for referencing Comments.
 */
export const GraphQLCommentReferenceInput = new GraphQLInputObjectType({
  name: 'CommentReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The public id identifying the comment',
    },
  }),
});
