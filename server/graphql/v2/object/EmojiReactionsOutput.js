import { GraphQLObjectType } from 'graphql';

import { Comment } from './Comment';
import Update from './Update';

/**
 * Object type for EmojiReaction mutation.
 */
export const EmojiReactionsOutput = new GraphQLObjectType({
  name: 'EmojiReactionOutput',
  fields: () => ({
    update: {
      type: Update,
      description: 'Reference to the update corresponding to the emojis',
    },
    comment: {
      type: Comment,
      description: 'Reference to the comment corresponding to the emojis',
    },
  }),
});
