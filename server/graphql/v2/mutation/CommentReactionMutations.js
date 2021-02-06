import { GraphQLNonNull, GraphQLString } from 'graphql';

import { mustBeLoggedInTo } from '../../../lib/auth';
import models from '../../../models';
import { canComment } from '../../common/expenses';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { CommentReferenceInput } from '../input/CommentReferenceInput';
import { Comment } from '../object/Comment';

const commentReactionMutations = {
  addCommentReaction: {
    type: new GraphQLNonNull(Comment),
    args: {
      emoji: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The emoji associated with the reaction',
      },
      comment: {
        type: new GraphQLNonNull(CommentReferenceInput),
        description: 'A unique identifier for the comment id associated with this comment reaction',
      },
    },
    resolve: async (entity, args, req) => {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

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

      const reaction = await models.CommentReaction.addReaction(req.remoteUser, commentId, args.emoji);
      return models.Comment.findByPk(reaction.CommentId);
    },
  },

  removeCommentReaction: {
    type: new GraphQLNonNull(Comment),
    args: {
      comment: {
        type: new GraphQLNonNull(CommentReferenceInput),
      },
      emoji: {
        type: new GraphQLNonNull(GraphQLString),
      },
    },
    resolve: async (_, { comment, emoji }, { remoteUser }) => {
      mustBeLoggedInTo(remoteUser, 'remove this comment reaction');
      const commentId = idDecode(comment.id, IDENTIFIER_TYPES.COMMENT);
      const reaction = await models.CommentReaction.findOne({
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
      return models.Comment.findByPk(reaction.CommentId);
    },
  },
};

export default commentReactionMutations;
