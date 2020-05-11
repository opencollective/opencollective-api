import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import { CollectiveReferenceInput } from './CollectiveReferenceInput';
import { CommentReferenceInput } from './CommentReferenceInput';

/**
 * Input type to use as the type for the comment input in createComment mutation.
 */
export const CommentReactionCreateInput = new GraphQLInputObjectType({
  name: 'CommentReactionCreateInput',
  fields: () => ({
    emoji: {
      type: GraphQLString,
      description: 'The emoji associated with the reaction',
    },
    comment: {
      type: CommentReferenceInput,
      description: 'A unique identifier for the comment id associated with this comment reaction',
    },
    fromCollectiveId: {
      type: CollectiveReferenceInput,
      description: 'A unique identifier for the collection associated with this comment',
    },
  }),
});
