import { pick } from 'lodash';

import { mustBeLoggedInTo } from '../../lib/auth';
import models from '../../models';
import { NotFound, Unauthorized, ValidationFailed } from '../errors';

import { canComment } from './expenses';
import { checkRemoteUserCanUseComment } from './scope-check';

/**
 * Return the collective ID for the given comment based on it's association (conversation,
 * expense or update).
 */
const getCollectiveIdForCommentEntity = async commentValues => {
  if (commentValues.ExpenseId) {
    const expense = await models.Expense.findByPk(commentValues.ExpenseId);
    return expense && expense.CollectiveId;
  } else if (commentValues.ConversationId) {
    const conversation = await models.Conversation.findByPk(commentValues.ConversationId);
    return conversation && conversation.CollectiveId;
  } else if (commentValues.UpdateId) {
    const update = await models.Update.findByPk(commentValues.UpdateId);
    return update && update.CollectiveId;
  }
};

/**
 *  Edits a comment
 * @param {object} comment - comment to edit
 * @param {object} remoteUser - logged user
 */
async function editComment(commentData, req) {
  mustBeLoggedInTo(req.remoteUser, 'edit this comment');

  const comment = await models.Comment.findByPk(commentData.id);
  if (!comment) {
    throw new NotFound(`This comment does not exist or has been deleted.`);
  }

  checkRemoteUserCanUseComment(comment, req);

  // Check permissions
  if (req.remoteUser.id !== comment.CreatedByUserId && !req.remoteUser.isAdmin(comment.CollectiveId)) {
    throw new Unauthorized('You must be the author or an admin of this collective to edit this comment');
  }

  // Prepare args and update
  const editableAttributes = ['html'];
  return await comment.update(pick(commentData, editableAttributes));
}

/**
 *  Deletes a comment
 * @param {number} id - comment identifier
 * @param {object} remoteUser - logged user
 */
async function deleteComment(id, req) {
  mustBeLoggedInTo(req.remoteUser, 'delete this comment');

  const comment = await models.Comment.findByPk(id);
  if (!comment) {
    throw new NotFound(`This comment does not exist or has been deleted.`);
  }

  checkRemoteUserCanUseComment(comment, req);

  // Check permissions
  if (req.remoteUser.id !== comment.CreatedByUserId && !req.remoteUser.isAdmin(comment.CollectiveId)) {
    throw new Unauthorized('You need to be logged in as a core contributor or as a host to delete this comment');
  }

  return comment.destroy();
}

async function createComment(commentData, req) {
  const { remoteUser } = req;
  mustBeLoggedInTo(remoteUser, 'create a comment');

  checkRemoteUserCanUseComment(commentData, req);

  if (!commentData.html) {
    throw new ValidationFailed('Comment is empty');
  }

  const { ConversationId, ExpenseId, UpdateId, html } = commentData;

  // Ensure at least (and only) one entity to comment is specified
  if ([ConversationId, ExpenseId, UpdateId].filter(Boolean).length !== 1) {
    throw new ValidationFailed('You must specify one entity to comment');
  }

  // Load entity and its collective id
  const CollectiveId = await getCollectiveIdForCommentEntity(commentData);
  if (!CollectiveId) {
    throw new ValidationFailed("The item you're trying to comment doesn't exist or has been deleted.");
  }

  if (ExpenseId) {
    const expense = await req.loaders.Expense.byId.load(ExpenseId);
    if (!expense || !(await canComment(req, expense))) {
      throw new ValidationFailed('You are not allowed to comment on this expense');
    }
  }

  // Create comment
  const comment = await models.Comment.create({
    CollectiveId,
    ExpenseId,
    UpdateId,
    ConversationId,
    html, // HTML is sanitized at the model level, no need to do it here
    CreatedByUserId: remoteUser.id,
    FromCollectiveId: remoteUser.CollectiveId,
  });

  if (ConversationId) {
    models.ConversationFollower.follow(remoteUser.id, ConversationId);
  }

  return comment;
}

function collectiveResolver({ CollectiveId }, _, { loaders }) {
  return loaders.Collective.byId.load(CollectiveId);
}

function fromCollectiveResolver({ FromCollectiveId }, _, { loaders }) {
  return loaders.Collective.byId.load(FromCollectiveId);
}

export { editComment, deleteComment, createComment, collectiveResolver, fromCollectiveResolver };
