import { pick } from 'lodash';

import ActivityTypes from '../../constants/activities';
import { mustBeLoggedInTo } from '../../lib/auth';
import models from '../../models';
import Comment, { CommentType } from '../../models/Comment';
import Conversation from '../../models/Conversation';
import Expense, { ExpenseStatus } from '../../models/Expense';
import Update from '../../models/Update';
import { NotFound, Unauthorized, ValidationFailed } from '../errors';

import { canComment, isHostAdmin } from './expenses';
import { checkRemoteUserCanUseComment } from './scope-check';
import { canSeeUpdate } from './update';

type CommentableEntity = Update | Expense | Conversation;

const loadCommentedEntity = async (commentValues): Promise<[CommentableEntity, ActivityTypes]> => {
  const include = { association: 'collective', required: true };
  let activityType = ActivityTypes.COLLECTIVE_COMMENT_CREATED;
  let entity;

  if (commentValues.ExpenseId) {
    entity = await Expense.findByPk(commentValues.ExpenseId, { include });
    activityType = ActivityTypes.EXPENSE_COMMENT_CREATED;
  } else if (commentValues.ConversationId) {
    entity = await Conversation.findByPk(commentValues.ConversationId, { include });
    activityType = ActivityTypes.CONVERSATION_COMMENT_CREATED;
  } else if (commentValues.UpdateId) {
    entity = await Update.findByPk(commentValues.UpdateId, { include });
    activityType = ActivityTypes.UPDATE_COMMENT_CREATED;
  }

  return [entity, activityType];
};

/**
 *  Edits a comment
 * @param {object} comment - comment to edit
 * @param {object} remoteUser - logged user
 */
async function editComment(commentData, req): Promise<Comment> {
  mustBeLoggedInTo(req.remoteUser, 'edit this comment');

  const comment = await Comment.findByPk(commentData.id);
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
async function deleteComment(id: number, req): Promise<void> {
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

async function createComment(commentData, req): Promise<Comment> {
  const { remoteUser } = req;
  mustBeLoggedInTo(remoteUser, 'create a comment');

  checkRemoteUserCanUseComment(commentData, req);

  if (!commentData.html) {
    throw new ValidationFailed('Comment is empty');
  }

  const { ConversationId, ExpenseId, UpdateId, html, type } = commentData;

  // Ensure at least (and only) one entity to comment is specified
  if ([ConversationId, ExpenseId, UpdateId].filter(Boolean).length !== 1) {
    throw new ValidationFailed('You must specify one entity to comment');
  }

  // Load entity and its collective id
  const [commentedEntity, activityType] = await loadCommentedEntity(commentData);
  if (!commentedEntity) {
    throw new ValidationFailed("The item you're trying to comment doesn't exist or has been deleted.");
  }

  const expense = ExpenseId && (await req.loaders.Expense.byId.load(ExpenseId));
  if (ExpenseId) {
    if (!(await canComment(req, commentedEntity as Expense))) {
      throw new ValidationFailed('You are not allowed to comment on this expense');
    }
    const userIsHostAdmin = await isHostAdmin(req, expense);
    if (type === CommentType.PRIVATE_NOTE && !userIsHostAdmin) {
      throw new Unauthorized('You need to be a host admin to post comments in this context');
    }
  } else if (UpdateId) {
    if (!(await canSeeUpdate(commentedEntity, req))) {
      throw new Unauthorized('You do not have the permission to post comments on this update');
    }
  }

  // Create comment
  const comment = await Comment.create({
    CreatedByUserId: remoteUser.id,
    FromCollectiveId: remoteUser.CollectiveId,
    CollectiveId: commentedEntity.collective.id,
    ExpenseId,
    UpdateId,
    ConversationId,
    html, // HTML is sanitized at the model level, no need to do it here
    type,
  });

  // Create activity
  await models.Activity.create({
    type: activityType,
    UserId: comment.CreatedByUserId,
    CollectiveId: comment.CollectiveId,
    FromCollectiveId: comment.FromCollectiveId,
    HostCollectiveId: commentedEntity.collective.approvedAt ? commentedEntity.collective.HostCollectiveId : null,
    ExpenseId: comment.ExpenseId,
    data: {
      CommentId: comment.id,
      comment: { id: comment.id, html: comment.html, type: comment.type },
      FromCollectiveId: comment.FromCollectiveId,
      ExpenseId: comment.ExpenseId,
      UpdateId: comment.UpdateId,
      ConversationId: comment.ConversationId,
    },
  });

  if (ExpenseId) {
    if (remoteUser.isAdmin(expense.FromCollectiveId) && expense?.status === ExpenseStatus.INCOMPLETE) {
      await expense.update({ status: ExpenseStatus.APPROVED });
      await expense.createActivity(ActivityTypes.COLLECTIVE_EXPENSE_APPROVED);
    }
  }

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
