import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import { Comment } from '../../../models';

/**
 * Input type to use as the type for the comment input in editComment mutation.
 */
export const GraphQLCommentUpdateInput = new GraphQLInputObjectType({
  name: 'CommentUpdateInput',
  fields: () => ({
    id: { type: GraphQLString, deprecationReason: '2026-02-25: use publicId' },
    publicId: { type: GraphQLString, description: `The resource public id (ie: ${Comment.nanoIdPrefix}_xxxxxxxx)` },
    html: { type: GraphQLString },
  }),
});
