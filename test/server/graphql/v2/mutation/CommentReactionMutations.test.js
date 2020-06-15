import { expect } from 'chai';

import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import { fakeComment, fakeCommentReaction, fakeExpense, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';
import * as utils from '../../../../utils';

describe('server/graphql/v2/mutation/CommentReactionMutations', () => {
  before(utils.resetTestDB);

  describe('addCommentReaction', () => {
    const addCommentReactionMutation = `
      mutation addCommentReaction($emoji: String!, $comment: CommentReferenceInput!) {
        addCommentReaction(emoji: $emoji, comment: $comment) {
          id
          reactions
          userReactions
        }
      }
    `;

    it('Must be authenticated', async () => {
      const comment = await fakeComment();
      const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
      const result = await graphqlQueryV2(addCommentReactionMutation, { comment: { id: commentId }, emoji: '🎉' });
      expect(result.errors[0].message).to.eq('You need to be authenticated to perform this action');
    });

    it('Must be allowed to comment', async () => {
      const user = await fakeUser();
      const expense = await fakeExpense();
      const comment = await fakeComment({ ExpenseId: expense.id });
      const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
      const result = await graphqlQueryV2(
        addCommentReactionMutation,
        { comment: { id: commentId }, emoji: '🎉' },
        user,
      );
      expect(result.errors[0].message).to.eq('You are not allowed to comment or add reactions on this expense');
    });

    it('Must be a valid emoji', async () => {
      const user = await fakeUser();
      const expense = await fakeExpense({ FromCollectiveId: user.CollectiveId });
      const comment = await fakeComment({ ExpenseId: expense.id });
      const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
      const result = await graphqlQueryV2(addCommentReactionMutation, { comment: { id: commentId }, emoji: 'X' }, user);
      expect(result.errors[0].message).to.eq('Validation error: Must be in 👍️,👎,😀,🎉,😕,❤️,🚀,👀');
    });

    it('Creates an returns a valid reaction', async () => {
      const user = await fakeUser();
      const expense = await fakeExpense({ FromCollectiveId: user.CollectiveId });
      const comment = await fakeComment({ ExpenseId: expense.id });
      const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
      const result = await graphqlQueryV2(
        addCommentReactionMutation,
        { comment: { id: commentId }, emoji: '🎉' },
        user,
      );

      expect(result.data.addCommentReaction).to.exist;
      expect(result.data.addCommentReaction.reactions).to.deep.eq({ '🎉': 1 });
      expect(result.data.addCommentReaction.userReactions).to.deep.eq(['🎉']);
    });

    it('can only add one reaction per type', async () => {
      const user = await fakeUser();
      const expense = await fakeExpense({ FromCollectiveId: user.CollectiveId });
      const comment = await fakeComment({ ExpenseId: expense.id });
      const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
      const result = await graphqlQueryV2(
        addCommentReactionMutation,
        { comment: { id: commentId }, emoji: '🎉' },
        user,
      );
      const result2 = await graphqlQueryV2(
        addCommentReactionMutation,
        { comment: { id: commentId }, emoji: '🎉' },
        user,
      );

      expect(result.data).to.exist;
      expect(result.data.addCommentReaction).to.exist;
      expect(result.data.addCommentReaction.reactions).to.deep.eq({ '🎉': 1 });
      expect(result.data.addCommentReaction.userReactions).to.deep.eq(['🎉']);
      expect(result2.data).to.exist;
      expect(result2.data.addCommentReaction).to.exist;
      expect(result2.data.addCommentReaction.reactions).to.deep.eq({ '🎉': 1 });
      expect(result2.data.addCommentReaction.userReactions).to.deep.eq(['🎉']);
    });
  });

  describe('removeCommentReaction', () => {
    const removeCommentReactionMutation = `
      mutation removeCommentReaction($emoji: String!, $comment: CommentReferenceInput!) {
        removeCommentReaction(emoji: $emoji, comment: $comment) {
          id
          reactions
          userReactions
        }
      }
    `;

    it('Must be authenticated', async () => {
      const reaction = await fakeCommentReaction();
      const commentId = idEncode(reaction.CommentId, IDENTIFIER_TYPES.COMMENT);
      const result = await graphqlQueryV2(removeCommentReactionMutation, { comment: { id: commentId }, emoji: '🎉' });
      expect(result.errors[0].message).to.eq('You must be logged in to remove this comment reaction');
    });

    it('Can only remove own reactions', async () => {
      const reaction = await fakeCommentReaction();
      const commentId = idEncode(reaction.CommentId, IDENTIFIER_TYPES.COMMENT);
      const user = await fakeUser();
      const mutationParams = { comment: { id: commentId }, emoji: reaction.emoji };
      const result = await graphqlQueryV2(removeCommentReactionMutation, mutationParams, user);
      expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
    });

    it('Removes a reaction', async () => {
      const reaction = await fakeCommentReaction();
      const commentId = idEncode(reaction.CommentId, IDENTIFIER_TYPES.COMMENT);
      const user = await reaction.getUser();
      const mutationParams = { comment: { id: commentId }, emoji: reaction.emoji };
      const result = await graphqlQueryV2(removeCommentReactionMutation, mutationParams, user);
      expect(result.data.removeCommentReaction).to.exist;
      expect(result.data.removeCommentReaction.reactions).to.deep.eq({});
      expect(result.data.removeCommentReaction.userReactions).to.deep.eq([]);
    });
  });
});
