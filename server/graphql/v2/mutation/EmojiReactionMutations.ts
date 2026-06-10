import type express from 'express';
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { REACTION_EMOJI } from '../../../constants/reaction-emoji';
import { mustBeLoggedInTo } from '../../../lib/auth';
import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import models from '../../../models';
import { isValidEmoji } from '../../../models/EmojiReaction';
import { canSeeComment } from '../../common/comment';
import { checkRemoteUserCanUseComment, checkRemoteUserCanUseUpdates } from '../../common/scope-check';
import { canSeeUpdate } from '../../common/update';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { Loaders } from '../../loaders';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLCommentReferenceInput } from '../input/CommentReferenceInput';
import { getDatabaseIdFromUpdateReference, GraphQLUpdateReferenceInput } from '../input/UpdateReferenceInput';
import { GraphQLComment } from '../object/Comment';
import GraphQLUpdate from '../object/Update';

/**
 * Object type for EmojiReaction mutation.
 */
const GraphQLEmojiReactionsResponse = new GraphQLObjectType({
  name: 'EmojiReactionResponse',
  fields: () => ({
    update: {
      type: GraphQLUpdate,
      description: 'Reference to the update corresponding to the emojis',
    },
    comment: {
      type: GraphQLComment,
      description: 'Reference to the comment corresponding to the emojis',
    },
  }),
});

const emojiReactionMutations = {
  addEmojiReaction: {
    type: new GraphQLNonNull(GraphQLEmojiReactionsResponse),
    description: 'Add an emoji reaction. Scope: "conversations", "expenses" or "updates".',
    args: {
      emoji: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The emoji associated with the reaction',
      },
      comment: {
        type: GraphQLCommentReferenceInput,
        description: 'A unique identifier for the comment id associated with this reaction',
      },
      update: {
        type: GraphQLUpdateReferenceInput,
        description: 'A unique identifier for the update id associated with this reaction',
      },
    },
    // eslint-disable-next-line graphql-mutations/require-scope-check -- scope check is performed inside addReactionToCommentOrUpdate
    resolve: async (entity, args, req) => {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      if (!args.comment && !args.update) {
        throw new Error('A comment or update must be provided');
      }

      // Scope is checked in addReactionToCommentOrUpdate
      if (args.comment) {
        const commentId = await getDatabaseIdFromCommentReference(args.comment);
        return addReactionToCommentOrUpdate(commentId, req, args.emoji, IDENTIFIER_TYPES.COMMENT);
      } else if (args.update) {
        const updateId = await getDatabaseIdFromUpdateReference(args.update);
        return addReactionToCommentOrUpdate(updateId, req, args.emoji, IDENTIFIER_TYPES.UPDATE);
      }
    },
  },
  removeEmojiReaction: {
    type: new GraphQLNonNull(GraphQLEmojiReactionsResponse),
    description: 'Remove an emoji reaction. Scope: "conversations", "expenses" or "updates".',
    args: {
      comment: {
        type: GraphQLCommentReferenceInput,
      },
      update: {
        type: GraphQLUpdateReferenceInput,
      },
      emoji: {
        type: new GraphQLNonNull(GraphQLString),
      },
    },
    // eslint-disable-next-line graphql-mutations/require-scope-check -- scope check is performed inside removeReactionFromCommentOrUpdate
    resolve: async (_, args, req) => {
      mustBeLoggedInTo(req.remoteUser, 'remove this comment reaction');

      if (!args.comment && !args.update) {
        throw new Error('A comment or update must be provided');
      }

      // Scope and permissions are checked in removeReactionFromCommentOrUpdate
      if (args.comment) {
        const commentId = await getDatabaseIdFromCommentReference(args.comment);
        return removeReactionFromCommentOrUpdate(commentId, req, args.emoji, IDENTIFIER_TYPES.COMMENT);
      } else if (args.update) {
        const updateId = await getDatabaseIdFromUpdateReference(args.update);
        return removeReactionFromCommentOrUpdate(updateId, req, args.emoji, IDENTIFIER_TYPES.UPDATE);
      }
    },
  },
};

type EntityIdentifierType = typeof IDENTIFIER_TYPES.COMMENT | typeof IDENTIFIER_TYPES.UPDATE;

/**
 * Loads the entity and checks the scope and permissions.
 */
const loadEntity = async (commentOrUpdateId: number, req: express.Request, identifierType: EntityIdentifierType) => {
  let commentOrUpdate;

  // Check existence and token scope
  if (identifierType === IDENTIFIER_TYPES.COMMENT) {
    commentOrUpdate = await models.Comment.findByPk(commentOrUpdateId);
    if (!commentOrUpdate) {
      throw new ValidationFailed('This comment does not exist');
    }

    checkRemoteUserCanUseComment(commentOrUpdate, req);
    if (!(await canSeeComment(req, commentOrUpdate))) {
      throw new Forbidden('You are not allowed to react on this comment');
    }
  } else {
    commentOrUpdate = await models.Update.findByPk(commentOrUpdateId);
    if (!commentOrUpdate) {
      throw new ValidationFailed('This update does not exist');
    }

    checkRemoteUserCanUseUpdates(req);
    if (!(await canSeeUpdate(req, commentOrUpdate))) {
      throw new Forbidden('You are not allowed to react on this update');
    }
  }

  return commentOrUpdate;
};

const addReactionToCommentOrUpdate = async (
  commentOrUpdateId: number,
  req: express.Request,
  emoji: string,
  identifierType: EntityIdentifierType,
) => {
  const commentOrUpdate = await loadEntity(commentOrUpdateId, req, identifierType);

  // Check emoji is valid
  if (!isValidEmoji(emoji)) {
    throw new ValidationFailed(`Invalid emoji. Must be one of: ${REACTION_EMOJI.join(', ')}`);
  }

  if (identifierType === IDENTIFIER_TYPES.COMMENT) {
    await models.EmojiReaction.addReactionOnComment(req.remoteUser, commentOrUpdateId, emoji);
    return { comment: commentOrUpdate, update: null };
  } else {
    await models.EmojiReaction.addReactionOnUpdate(req.remoteUser, commentOrUpdateId, emoji);
    return { update: commentOrUpdate, comment: null };
  }
};

const removeReactionFromCommentOrUpdate = async (
  commentOrUpdateId: number,
  req: express.Request,
  emoji: string,
  identifierType: EntityIdentifierType,
) => {
  const commentOrUpdate = await loadEntity(commentOrUpdateId, req, identifierType);

  const idColumn = identifierType === IDENTIFIER_TYPES.COMMENT ? 'CommentId' : 'UpdateId';
  const emojiRemoved = await models.EmojiReaction.destroy({
    where: {
      [idColumn]: commentOrUpdateId,
      UserId: req.remoteUser.id,
      emoji,
    },
  });

  if (!emojiRemoved) {
    throw new NotFound(`This reaction does not exist or has been deleted or you do not have permission to change it.`);
  }

  if (identifierType === IDENTIFIER_TYPES.COMMENT) {
    return { comment: commentOrUpdate, update: null };
  } else {
    return { update: commentOrUpdate, comment: null };
  }
};

function getDatabaseIdFromCommentReference(
  comment: { id: string },
  { loaders = null }: { loaders?: Loaders } = {},
): Promise<number> {
  if (isEntityPublicId(comment.id, EntityShortIdPrefix.Comment)) {
    return (
      loaders
        ? loaders.Comment.byPublicId.load(comment.id)
        : models.Comment.findOne({ where: { publicId: comment.id }, attributes: ['id'] })
    ).then(resolvedComment => {
      if (!resolvedComment) {
        throw new NotFound(`Comment with public id ${comment.id} not found`);
      }
      return resolvedComment.id;
    });
  } else if (comment.id) {
    return Promise.resolve(idDecode(comment.id, IDENTIFIER_TYPES.COMMENT));
  } else {
    throw new Error('Invalid comment reference');
  }
}

export default emojiReactionMutations;
