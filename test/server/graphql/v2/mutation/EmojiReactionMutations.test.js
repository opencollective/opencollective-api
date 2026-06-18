import { expect } from 'chai';
import gql from 'fake-tag';

import roles from '../../../../../server/constants/roles';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import { EntityShortIdPrefix } from '../../../../../server/lib/permalink/entity-map';
import {
  fakeActiveHost,
  fakeCollective,
  fakeComment,
  fakeEmojiReaction,
  fakeExpense,
  fakeHostApplication,
  fakeMember,
  fakeUpdate,
  fakeUser,
  fakeUserToken,
} from '../../../../test-helpers/fake-data';
import { createPrivateAccountFixture } from '../../../../test-helpers/private-account-fixture';
import * as utils from '../../../../utils';
import { graphqlQueryV2, oAuthGraphqlQueryV2 } from '../../../../utils';

const createHostApplicationCommentContext = async () => {
  const host = await fakeActiveHost();
  const hostAdmin = await fakeUser();
  await fakeMember({ CollectiveId: host.id, MemberCollectiveId: hostAdmin.CollectiveId, role: roles.ADMIN });
  await hostAdmin.populateRoles();

  const collectiveAdmin = await fakeUser();
  const applyingCollective = await fakeCollective({
    HostCollectiveId: host.id,
    admin: collectiveAdmin,
    isActive: false,
    approvedAt: null,
  });
  await collectiveAdmin.populateRoles();

  const hostApplication = await fakeHostApplication({
    CollectiveId: applyingCollective.id,
    HostCollectiveId: host.id,
  });
  const comment = await fakeComment({
    HostApplicationId: hostApplication.id,
    ExpenseId: null,
    CollectiveId: applyingCollective.id,
    FromCollectiveId: collectiveAdmin.CollectiveId,
  });

  return { hostAdmin, collectiveAdmin, comment, randomUser: await fakeUser() };
};

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
      expect(result.errors[0].message).to.eq('You are not allowed to react on this comment');
    });

    it('rejects reactions when the commented entity was deleted', async () => {
      const user = await fakeUser();
      const expense = await fakeExpense({ FromCollectiveId: user.CollectiveId });
      const comment = await fakeComment({ ExpenseId: expense.id });
      await expense.destroy({ force: true });
      const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
      const result = await graphqlQueryV2(addReactionMutation, { comment: { id: commentId }, emoji: '🎉' }, user);
      expect(result.errors[0].message).to.eq('You are not allowed to react on this comment');
    });

    it('Must be a valid emoji', async () => {
      const user = await fakeUser();
      const expense = await fakeExpense({ FromCollectiveId: user.CollectiveId });
      const comment = await fakeComment({ ExpenseId: expense.id });
      const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
      const result = await graphqlQueryV2(addReactionMutation, { comment: { id: commentId }, emoji: 'X' }, user);
      expect(result.errors[0].message).to.eq('Invalid emoji. Must be one of: 👍️, 👎, 😀, 🎉, 😕, ❤️, 🚀, 👀');
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

    it('accepts publicId in CommentReferenceInput', async () => {
      const user = await fakeUser();
      const expense = await fakeExpense({ FromCollectiveId: user.CollectiveId });
      const comment = await fakeComment({ ExpenseId: expense.id });
      const publicId = `${EntityShortIdPrefix.Comment}_${comment.id}`;
      await comment.update({ publicId });

      const result = await graphqlQueryV2(addReactionMutation, { comment: { id: publicId }, emoji: '🎉' }, user);

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
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

    describe('update visibility', () => {
      it('rejects reactions on private updates from users who cannot see them', async () => {
        const collectiveAdmin = await fakeUser();
        const randomUser = await fakeUser();
        const collective = await fakeCollective({ admin: collectiveAdmin.collective });
        const privateUpdate = await fakeUpdate({
          CollectiveId: collective.id,
          publishedAt: new Date(),
          isPrivate: true,
          notificationAudience: 'COLLECTIVE_ADMINS',
        });
        const updateId = idEncode(privateUpdate.id, IDENTIFIER_TYPES.UPDATE);

        const result = await graphqlQueryV2(addReactionMutation, { update: { id: updateId }, emoji: '🎉' }, randomUser);

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are not allowed to react on this update');
      });

      it('allows collective admins to react on private updates', async () => {
        const collectiveAdmin = await fakeUser();
        const collective = await fakeCollective({ admin: collectiveAdmin.collective });
        const privateUpdate = await fakeUpdate({
          CollectiveId: collective.id,
          publishedAt: new Date(),
          isPrivate: true,
          notificationAudience: 'COLLECTIVE_ADMINS',
        });
        const updateId = idEncode(privateUpdate.id, IDENTIFIER_TYPES.UPDATE);

        const result = await graphqlQueryV2(
          addReactionMutation,
          { update: { id: updateId }, emoji: '🎉' },
          collectiveAdmin,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.addEmojiReaction.update.reactions).to.deep.eq({ '🎉': 1 });
      });

      it('rejects reactions on draft updates from non-admins', async () => {
        const collectiveAdmin = await fakeUser();
        const randomUser = await fakeUser();
        const collective = await fakeCollective({ admin: collectiveAdmin.collective });
        const draftUpdate = await fakeUpdate({ CollectiveId: collective.id, publishedAt: null });
        const updateId = idEncode(draftUpdate.id, IDENTIFIER_TYPES.UPDATE);

        const result = await graphqlQueryV2(addReactionMutation, { update: { id: updateId }, emoji: '🎉' }, randomUser);

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are not allowed to react on this update');
      });
    });

    describe('private organization visibility', () => {
      let ctx;

      before(async () => {
        ctx = await createPrivateAccountFixture();
      });

      it('rejects reactions on updates from private organizations for unrelated users', async () => {
        const updateId = idEncode(ctx.privateUpdate.id, IDENTIFIER_TYPES.UPDATE);
        const result = await graphqlQueryV2(
          addReactionMutation,
          { update: { id: updateId }, emoji: '🎉' },
          ctx.randomUser,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are not allowed to react on this update');
      });

      it('allows reactions on updates from private organizations for collective admins', async () => {
        const updateId = idEncode(ctx.privateUpdate.id, IDENTIFIER_TYPES.UPDATE);
        const result = await graphqlQueryV2(
          addReactionMutation,
          { update: { id: updateId }, emoji: '🎉' },
          ctx.privateCollectiveAdmin,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.addEmojiReaction.update.reactions).to.deep.eq({ '🎉': 1 });
      });

      it('rejects reactions on expense comments from private organizations for unrelated users', async () => {
        const comment = await fakeComment({ ExpenseId: ctx.privateExpense.id, CollectiveId: ctx.privateCollective.id });
        const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
        const result = await graphqlQueryV2(
          addReactionMutation,
          { comment: { id: commentId }, emoji: '🎉' },
          ctx.randomUser,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are not allowed to react on this comment');
      });
    });

    describe('OAuth scopes', () => {
      it('requires the expenses scope for expense comment reactions', async () => {
        const user = await fakeUser();
        const expense = await fakeExpense({ FromCollectiveId: user.CollectiveId });
        const comment = await fakeComment({ ExpenseId: expense.id });
        const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
        const userToken = await fakeUserToken({ UserId: user.id, scope: ['account'] });

        const result = await oAuthGraphqlQueryV2(
          addReactionMutation,
          { comment: { id: commentId }, emoji: '🎉' },
          userToken,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('The User Token is not allowed for operations in scope "expenses".');
      });

      it('requires the updates scope for update reactions', async () => {
        const user = await fakeUser();
        const collective = await fakeCollective();
        const update = await fakeUpdate({ CollectiveId: collective.id, publishedAt: new Date() });
        const updateId = idEncode(update.id, IDENTIFIER_TYPES.UPDATE);
        const userToken = await fakeUserToken({ UserId: user.id, scope: ['expenses'] });

        const result = await oAuthGraphqlQueryV2(
          addReactionMutation,
          { update: { id: updateId }, emoji: '🎉' },
          userToken,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('The User Token is not allowed for operations in scope "updates".');
      });

      it('requires the updates scope for update comment reactions', async () => {
        const user = await fakeUser();
        const collective = await fakeCollective();
        const update = await fakeUpdate({ CollectiveId: collective.id, publishedAt: new Date() });
        const comment = await fakeComment({ CollectiveId: collective.id });
        await comment.update({ UpdateId: update.id, ExpenseId: null });
        const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
        const userToken = await fakeUserToken({ UserId: user.id, scope: ['expenses'] });

        const result = await oAuthGraphqlQueryV2(
          addReactionMutation,
          { comment: { id: commentId }, emoji: '🎉' },
          userToken,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('The User Token is not allowed for operations in scope "updates".');
      });

      it('requires the account scope for host application comment reactions', async () => {
        const { collectiveAdmin, comment } = await createHostApplicationCommentContext();
        const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
        const userToken = await fakeUserToken({ UserId: collectiveAdmin.id, scope: ['expenses'] });

        const result = await oAuthGraphqlQueryV2(
          addReactionMutation,
          { comment: { id: commentId }, emoji: '🎉' },
          userToken,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('The User Token is not allowed for operations in scope "account".');
      });
    });

    describe('host application comments', () => {
      it('allows collective admins to react on host application comments', async () => {
        const { collectiveAdmin, comment } = await createHostApplicationCommentContext();
        const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);

        const result = await graphqlQueryV2(
          addReactionMutation,
          { comment: { id: commentId }, emoji: '🎉' },
          collectiveAdmin,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.addEmojiReaction.comment.reactions).to.deep.eq({ '🎉': 1 });
      });

      it('allows host admins to react on host application comments', async () => {
        const { hostAdmin, comment } = await createHostApplicationCommentContext();
        const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);

        const result = await graphqlQueryV2(
          addReactionMutation,
          { comment: { id: commentId }, emoji: '🎉' },
          hostAdmin,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.addEmojiReaction.comment.reactions).to.deep.eq({ '🎉': 1 });
      });

      it('rejects reactions on host application comments from unrelated users', async () => {
        const { randomUser, comment } = await createHostApplicationCommentContext();
        const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);

        const result = await graphqlQueryV2(
          addReactionMutation,
          { comment: { id: commentId }, emoji: '🎉' },
          randomUser,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are not allowed to react on this comment');
      });
    });

    describe('update comment visibility', () => {
      it('rejects reactions on comments attached to private updates from users who cannot see them', async () => {
        const collectiveAdmin = await fakeUser();
        const randomUser = await fakeUser();
        const collective = await fakeCollective({ admin: collectiveAdmin.collective });
        const privateUpdate = await fakeUpdate({
          CollectiveId: collective.id,
          publishedAt: new Date(),
          isPrivate: true,
          notificationAudience: 'COLLECTIVE_ADMINS',
        });
        const comment = await fakeComment({ CollectiveId: collective.id });
        await comment.update({ UpdateId: privateUpdate.id, ExpenseId: null });
        const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);

        const result = await graphqlQueryV2(
          addReactionMutation,
          { comment: { id: commentId }, emoji: '🎉' },
          randomUser,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are not allowed to react on this comment');
      });
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
      const user = await fakeUser();
      const collective = await fakeCollective();
      const update = await fakeUpdate({ CollectiveId: collective.id, publishedAt: new Date() });
      const reaction = await fakeEmojiReaction({ UserId: user.id, UpdateId: update.id });
      const updateId = idEncode(update.id, IDENTIFIER_TYPES.UPDATE);
      const mutationParams = { update: { id: updateId }, emoji: reaction.emoji };
      const result = await graphqlQueryV2(removeReactionMutation, mutationParams, user);
      expect(result.data.removeEmojiReaction).to.exist;
      expect(result.data.removeEmojiReaction.update.reactions).to.deep.eq({});
      expect(result.data.removeEmojiReaction.update.userReactions).to.deep.eq([]);
    });

    it('rejects removing reactions on private updates from users who cannot see them', async () => {
      const collectiveAdmin = await fakeUser();
      const randomUser = await fakeUser();
      const collective = await fakeCollective({ admin: collectiveAdmin.collective });
      const privateUpdate = await fakeUpdate({
        CollectiveId: collective.id,
        publishedAt: new Date(),
        isPrivate: true,
        notificationAudience: 'COLLECTIVE_ADMINS',
      });
      const reaction = await fakeEmojiReaction({ UserId: randomUser.id, UpdateId: privateUpdate.id });
      const updateId = idEncode(privateUpdate.id, IDENTIFIER_TYPES.UPDATE);
      const result = await graphqlQueryV2(
        removeReactionMutation,
        { update: { id: updateId }, emoji: reaction.emoji },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('You are not allowed to react on this update');
    });

    describe('OAuth scopes', () => {
      it('requires the expenses scope to remove expense comment reactions', async () => {
        const user = await fakeUser();
        const expense = await fakeExpense({ FromCollectiveId: user.CollectiveId });
        const comment = await fakeComment({ ExpenseId: expense.id });
        const reaction = await fakeEmojiReaction({ UserId: user.id, CommentId: comment.id });
        const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
        const userToken = await fakeUserToken({ UserId: user.id, scope: ['account'] });

        const result = await oAuthGraphqlQueryV2(
          removeReactionMutation,
          { comment: { id: commentId }, emoji: reaction.emoji },
          userToken,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('The User Token is not allowed for operations in scope "expenses".');
      });

      it('requires the updates scope to remove update reactions', async () => {
        const user = await fakeUser();
        const collective = await fakeCollective();
        const update = await fakeUpdate({ CollectiveId: collective.id, publishedAt: new Date() });
        const reaction = await fakeEmojiReaction({ UserId: user.id, UpdateId: update.id });
        const updateId = idEncode(update.id, IDENTIFIER_TYPES.UPDATE);
        const userToken = await fakeUserToken({ UserId: user.id, scope: ['expenses'] });

        const result = await oAuthGraphqlQueryV2(
          removeReactionMutation,
          { update: { id: updateId }, emoji: reaction.emoji },
          userToken,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('The User Token is not allowed for operations in scope "updates".');
      });

      it('requires the account scope to remove host application comment reactions', async () => {
        const { collectiveAdmin, comment } = await createHostApplicationCommentContext();
        const reaction = await fakeEmojiReaction({ UserId: collectiveAdmin.id, CommentId: comment.id });
        const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);
        const userToken = await fakeUserToken({ UserId: collectiveAdmin.id, scope: ['expenses'] });

        const result = await oAuthGraphqlQueryV2(
          removeReactionMutation,
          { comment: { id: commentId }, emoji: reaction.emoji },
          userToken,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('The User Token is not allowed for operations in scope "account".');
      });
    });

    describe('host application comments', () => {
      it('allows collective admins to remove reactions on host application comments', async () => {
        const { collectiveAdmin, comment } = await createHostApplicationCommentContext();
        const reaction = await fakeEmojiReaction({ UserId: collectiveAdmin.id, CommentId: comment.id });
        const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);

        const result = await graphqlQueryV2(
          removeReactionMutation,
          { comment: { id: commentId }, emoji: reaction.emoji },
          collectiveAdmin,
        );

        expect(result.data.removeEmojiReaction).to.exist;
        expect(result.data.removeEmojiReaction.comment.reactions).to.deep.eq({});
      });

      it('rejects removing reactions on host application comments from unrelated users', async () => {
        const { randomUser, comment } = await createHostApplicationCommentContext();
        const reaction = await fakeEmojiReaction({ UserId: randomUser.id, CommentId: comment.id });
        const commentId = idEncode(comment.id, IDENTIFIER_TYPES.COMMENT);

        const result = await graphqlQueryV2(
          removeReactionMutation,
          { comment: { id: commentId }, emoji: reaction.emoji },
          randomUser,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are not allowed to react on this comment');
      });
    });

    describe('private organization visibility', () => {
      let ctx;

      before(async () => {
        ctx = await createPrivateAccountFixture();
      });

      it('rejects removing reactions on updates from private organizations for unrelated users', async () => {
        const reaction = await fakeEmojiReaction({ UserId: ctx.randomUser.id, UpdateId: ctx.privateUpdate.id });
        const updateId = idEncode(ctx.privateUpdate.id, IDENTIFIER_TYPES.UPDATE);
        const result = await graphqlQueryV2(
          removeReactionMutation,
          { update: { id: updateId }, emoji: reaction.emoji },
          ctx.randomUser,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are not allowed to react on this update');
      });
    });
  });
});
