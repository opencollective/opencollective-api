import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { Comment } from '../../../models';

/**
 * Input type to use as the type for the comment input in editComment mutation.
 */
export const GraphQLCommentUpdateInput = new GraphQLInputObjectType({
  name: 'CommentUpdateInput',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: `The public id identifying the comment (ie: ${Comment.nanoIdPrefix}_xxxxxxxx)`,
    },
    html: { type: GraphQLString },
  }),
});
