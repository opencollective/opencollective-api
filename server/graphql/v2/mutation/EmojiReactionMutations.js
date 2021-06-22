import { GraphQLNonNull, GraphQLString } from 'graphql';

import { mustBeLoggedInTo } from '../../../lib/auth';
import models from '../../../models';
import { canComment } from '../../common/expenses';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { CommentReferenceInput } from '../input/CommentReferenceInput';
import { UpdateReferenceInput } from '../input/UpdateReferenceInput';
import { EmojiReactionsOutput } from '../object/EmojiReactionsOutput';

const emojiReactionMutations = {
  addEmojiReaction: {
    type: new GraphQLNonNull(EmojiReactionsOutput),
    args: {
      emoji: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The emoji associated with the reaction',
      },
      comment: {
        type: CommentReferenceInput,
        description: 'A unique identifier for the comment id associated with this reaction',
      },
      update: {
        type: UpdateReferenceInput,
        description: 'A unique identifier for the update id associated with this reaction',
      },
    },
    resolve: async (entity, args, req) => {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      if (!args.comment && !args.update) {
        throw new Error('A comment or update must be provided');
      }

      if (args.comment) {
        const commentId = idDecode(args.comment.id, IDENTIFIER_TYPES.COMMENT);
        const comment = await models.Comment.findByPk(commentId);

        if (!comment) {
          throw new ValidationFailed('This comment does not exist');
        } else if (comment.ExpenseId) {
          const expense = await models.Expense.findByPk(comment.ExpenseId);
          if (!expense || !(await canComment(req, expense))) {
            throw new Forbidden('You are not allowed to comment or add reactions on this expense');
          }
        }
        const reaction = await models.EmojiReaction.addReactionOnComment(req.remoteUser, commentId, args.emoji);
        return { comment: models.Comment.findByPk(reaction.CommentId), update: null };
      } else if (args.update) {
        const updateId = idDecode(args.update.id, IDENTIFIER_TYPES.UPDATE);
        const update = await models.Update.findByPk(updateId);

        if (!update) {
          throw new ValidationFailed('This update does not exist');
        }

        const reaction = await models.EmojiReaction.addReactionOnUpdate(req.remoteUser, updateId, args.emoji);
        return { update: models.Update.findByPk(reaction.UpdateId), comment: null };
      }
    },
  },
  removeEmojiReaction: {
    type: new GraphQLNonNull(EmojiReactionsOutput),
    args: {
      comment: {
        type: CommentReferenceInput,
      },
      update: {
        type: UpdateReferenceInput,
      },
      emoji: {
        type: new GraphQLNonNull(GraphQLString),
      },
    },
    resolve: async (_, { comment, update, emoji }, { remoteUser }) => {
      mustBeLoggedInTo(remoteUser, 'remove this comment reaction');

      if (!comment && !update) {
        throw new Error('A comment or update must be provided');
      }

      if (comment) {
        const commentId = idDecode(comment.id, IDENTIFIER_TYPES.COMMENT);
        const reaction = await models.EmojiReaction.findOne({
          where: {
            CommentId: commentId,
            emoji,
          },
        });

        if (!reaction) {
          throw new NotFound(`This comment reaction does not exist or has been deleted.`);
        }

        // Check permissions
        if (!remoteUser.isAdmin(reaction.FromCollectiveId)) {
          throw new Forbidden();
        }

        await reaction.destroy();
        return { comment: models.Comment.findByPk(reaction.CommentId), update: null };
      } else if (update) {
        const updateId = idDecode(update.id, IDENTIFIER_TYPES.UPDATE);
        const reaction = await models.EmojiReaction.findOne({
          where: {
            UpdateId: updateId,
            emoji,
          },
        });

        if (!reaction) {
          throw new NotFound(`This update reaction does not exist or has been deleted.`);
        }

        // Check permissions
        if (!remoteUser.isAdmin(reaction.FromCollectiveId)) {
          throw new Forbidden();
        }

        await reaction.destroy();
        return { update: models.Update.findByPk(reaction.UpdateId), comment: null };
      }
    },
  },
};

export default emojiReactionMutations;
