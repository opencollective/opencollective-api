import { expect } from 'chai';
import gql from 'fake-tag';

import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import {
  fakeCollective,
  fakeComment,
  fakeEmojiReaction,
  fakeExpense,
  fakeUpdate,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';
import * as utils from '../../../../utils';

describe('server/graphql/v2/mutation/EmojiReactionMutations', () => {
  before(utils.resetTestDB);

  describe('Add Emoji Reaction', () => {
    const addReactionMutation = gql`
      mutation AddReaction($emoji: String!, $comment: CommentReferenceInput, $update: UpdateReferenceInput) {
        addEmojiReaction(emoji: $emoji, comment: $comment, update: $update) {
          comment {
            id
            reactions
            userReactions
          }
          update {
            id
            reactions
            userReactions
          }
        }
      }
    `;

    it('Must be authenticated', async () => {
      const comment = await fakeComment();
      const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
      const result = await graphqlQueryV2(addReactionMutation, { comment: { id: commentId }, emoji: '🎉' });
      expect(result.errors[0].message).to.eq('You need to be authenticated to perform this action');
    });

    it('Must be allowed to comment', async () => {
      const user = await fakeUser();
      const expense = await fakeExpense();
      const comment = await fakeComment({ ExpenseId: expense.id });
      const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
      const result = await graphqlQueryV2(addReactionMutation, { comment: { id: commentId }, emoji: '🎉' }, user);
      expect(result.errors[0].message).to.eq('You are not allowed to comment or add reactions on this expense');
    });

    it('Must be a valid emoji', async () => {
      const user = await fakeUser();
      const expense = await fakeExpense({ FromCollectiveId: user.CollectiveId });
      const comment = await fakeComment({ ExpenseId: expense.id });
      const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
      const result = await graphqlQueryV2(addReactionMutation, { comment: { id: commentId }, emoji: 'X' }, user);
      expect(result.errors[0].message).to.eq('Validation error: Must be in 👍️,👎,😀,🎉,😕,❤️,🚀,👀');
    });

    it('Creates and returns a valid reaction', async () => {
      const user = await fakeUser();
      const expense = await fakeExpense({ FromCollectiveId: user.CollectiveId });
      const comment = await fakeComment({ ExpenseId: expense.id });
      const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
      const result = await graphqlQueryV2(addReactionMutation, { comment: { id: commentId }, emoji: '🎉' }, user);

      expect(result.data.addEmojiReaction).to.exist;
      expect(result.data.addEmojiReaction.comment.reactions).to.deep.eq({ '🎉': 1 });
      expect(result.data.addEmojiReaction.comment.userReactions).to.deep.eq(['🎉']);
    });

    it('can only add one reaction per type', async () => {
      const user = await fakeUser();
      const expense = await fakeExpense({ FromCollectiveId: user.CollectiveId });
      const comment = await fakeComment({ ExpenseId: expense.id });
      const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
      const result = await graphqlQueryV2(addReactionMutation, { comment: { id: commentId }, emoji: '🎉' }, user);
      const result2 = await graphqlQueryV2(addReactionMutation, { comment: { id: commentId }, emoji: '🎉' }, user);

      expect(result.data).to.exist;
      expect(result.data.addEmojiReaction).to.exist;
      expect(result.data.addEmojiReaction.comment.reactions).to.deep.eq({ '🎉': 1 });
      expect(result.data.addEmojiReaction.comment.userReactions).to.deep.eq(['🎉']);
      expect(result2.data).to.exist;
      expect(result2.data.addEmojiReaction).to.exist;
      expect(result2.data.addEmojiReaction.comment.reactions).to.deep.eq({ '🎉': 1 });
      expect(result2.data.addEmojiReaction.comment.userReactions).to.deep.eq(['🎉']);
    });

    it('Creates and returns a valid update reaction', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const update = await fakeUpdate({ CollectiveId: collective.id, publishedAt: new Date() });
      const updateId = idEncode(update.id, IDENTIFIER_TYPES.UPDATE);
      const result = await graphqlQueryV2(addReactionMutation, { update: { id: updateId }, emoji: '🎉' }, user);

      expect(result.data).to.exist;
      expect(result.data.addEmojiReaction).to.exist;
      expect(result.data.addEmojiReaction.update.reactions).to.deep.eq({ '🎉': 1 });
      expect(result.data.addEmojiReaction.update.userReactions).to.deep.eq(['🎉']);
    });
  });

  describe('Remove Emoji Reaction', () => {
    const removeReactionMutation = gql`
      mutation RemoveReaction($emoji: String!, $comment: CommentReferenceInput, $update: UpdateReferenceInput) {
        removeEmojiReaction(emoji: $emoji, comment: $comment, update: $update) {
          comment {
            id
            reactions
            userReactions
          }
          update {
            id
            reactions
            userReactions
          }
        }
      }
    `;

    it('Must be authenticated', async () => {
      const reaction = await fakeEmojiReaction(undefined, { isComment: true });
      const commentId = idEncode(reaction.CommentId, IDENTIFIER_TYPES.COMMENT);
      const result = await graphqlQueryV2(removeReactionMutation, { comment: { id: commentId }, emoji: '🎉' });
      expect(result.errors[0].message).to.eq('You must be logged in to remove this comment reaction');
    });

    it('Can only remove own reactions', async () => {
      const reaction = await fakeEmojiReaction(undefined, { isComment: true });
      const commentId = idEncode(reaction.CommentId, IDENTIFIER_TYPES.COMMENT);
      const user = await fakeUser();
      const mutationParams = { comment: { id: commentId }, emoji: reaction.emoji };
      const result = await graphqlQueryV2(removeReactionMutation, mutationParams, user);
      expect(result.errors[0].message).to.eq(
        'This reaction does not exist or has been deleted or you do not have permission to change it.',
      );
    });

    it('Removes a reaction', async () => {
      const reaction = await fakeEmojiReaction(undefined, { isComment: true });
      const commentId = idEncode(reaction.CommentId, IDENTIFIER_TYPES.COMMENT);
      const user = await reaction.getUser();
      const mutationParams = { comment: { id: commentId }, emoji: reaction.emoji };
      const result = await graphqlQueryV2(removeReactionMutation, mutationParams, user);
      expect(result.data.removeEmojiReaction).to.exist;
      expect(result.data.removeEmojiReaction.comment.reactions).to.deep.eq({});
      expect(result.data.removeEmojiReaction.comment.userReactions).to.deep.eq([]);
    });

    it('Removes a reaction from an update', async () => {
      const reaction = await fakeEmojiReaction(undefined, { isComment: false });
      const updateId = idEncode(reaction.UpdateId, IDENTIFIER_TYPES.UPDATE);
      const user = await reaction.getUser();
      const mutationParams = { update: { id: updateId }, emoji: reaction.emoji };
      const result = await graphqlQueryV2(removeReactionMutation, mutationParams, user);
      expect(result.data.removeEmojiReaction).to.exist;
      expect(result.data.removeEmojiReaction.update.reactions).to.deep.eq({});
      expect(result.data.removeEmojiReaction.update.userReactions).to.deep.eq([]);
    });
  });
});
