import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { mustBeLoggedInTo } from '../../../lib/auth';
import models from '../../../models';
import { canComment } from '../../common/expenses';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { CommentReferenceInput } from '../input/CommentReferenceInput';
import { UpdateReferenceInput } from '../input/UpdateReferenceInput';
import { Comment } from '../object/Comment';
import Update from '../object/Update';

/**
 * Object type for EmojiReaction mutation.
 */
const EmojiReactionsResponse = new GraphQLObjectType({
  name: 'EmojiReactionResponse',
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

const emojiReactionMutations = {
  addEmojiReaction: {
    type: new GraphQLNonNull(EmojiReactionsResponse),
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
        return addReactionToCommentOrUpdate(args.comment.id, req, args.emoji, IDENTIFIER_TYPES.COMMENT);
      } else if (args.update) {
        return addReactionToCommentOrUpdate(args.update.id, req, args.emoji, IDENTIFIER_TYPES.UPDATE);
      }
    },
  },
  removeEmojiReaction: {
    type: new GraphQLNonNull(EmojiReactionsResponse),
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
        return removeReactionFromCommentOrUpdate(comment.id, remoteUser, emoji, IDENTIFIER_TYPES.COMMENT);
      } else if (update) {
        return removeReactionFromCommentOrUpdate(update.id, remoteUser, emoji, IDENTIFIER_TYPES.UPDATE);
      }
    },
  },
};

const addReactionToCommentOrUpdate = async (id, req, emoji, identifierType) => {
  const commentOrUpdateId = idDecode(id, identifierType);

  let commentOrUpdate;
  if (identifierType === IDENTIFIER_TYPES.COMMENT) {
    commentOrUpdate = await models.Comment.findByPk(commentOrUpdateId);
  } else {
    commentOrUpdate = await models.Update.findByPk(commentOrUpdateId);
  }

  if (!commentOrUpdate) {
    if (identifierType === IDENTIFIER_TYPES.COMMENT) {
      throw new ValidationFailed('This comment does not exist');
    } else {
      throw new ValidationFailed('This update does not exist');
    }
  } else if (identifierType === IDENTIFIER_TYPES.COMMENT && commentOrUpdate.ExpenseId) {
    const expense = await models.Expense.findByPk(commentOrUpdate.ExpenseId);
    if (!expense || !(await canComment(req, expense))) {
      throw new Forbidden('You are not allowed to comment or add reactions on this expense');
    }
  }

  if (identifierType === IDENTIFIER_TYPES.COMMENT) {
    await models.EmojiReaction.addReactionOnComment(req.remoteUser, commentOrUpdateId, emoji);
    return { comment: commentOrUpdate, update: null };
  } else {
    await models.EmojiReaction.addReactionOnUpdate(req.remoteUser, commentOrUpdateId, emoji);
    return { update: commentOrUpdate, comment: null };
  }
};

const removeReactionFromCommentOrUpdate = async (id, remoteUser, emoji, identifierType) => {
  const commentOrUpdateId = idDecode(id, identifierType);
  const idColumn = identifierType === IDENTIFIER_TYPES.COMMENT ? 'CommentId' : 'UpdateId';
  const emojiRemoved = await models.EmojiReaction.destroy({
    where: {
      [idColumn]: commentOrUpdateId,
      UserId: remoteUser.id,
      emoji,
    },
  });

  if (!emojiRemoved) {
    throw new NotFound(`This reaction does not exist or has been deleted or you do not have permission to change it.`);
  }

  if (identifierType === IDENTIFIER_TYPES.COMMENT) {
    return { comment: await models.Comment.findByPk(commentOrUpdateId), update: null };
  } else {
    return { update: await models.Update.findByPk(commentOrUpdateId), comment: null };
  }
};

export default emojiReactionMutations;
