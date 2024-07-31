import { pick } from 'lodash';

import ActivityTypes from '../../constants/activities';
import { mustBeLoggedInTo } from '../../lib/auth';
import models from '../../models';
import Comment, { CommentType } from '../../models/Comment';
import Conversation from '../../models/Conversation';
import Expense from '../../models/Expense';
import Order from '../../models/Order';
import Update from '../../models/Update';
import { NotFound, Unauthorized, ValidationFailed } from '../errors';
import { canComment as canCommentOrder } from '../v2/object/OrderPermissions';

import { canComment as canCommentExpense, canUsePrivateNotes as canUseExpensePrivateNotes } from './expenses';
import { checkRemoteUserCanUseComment } from './scope-check';
import { canSeeUpdate } from './update';

type CommentableEntity = Update | Expense | Conversation | Order;

const loadCommentedEntity = async (commentValues): Promise<[CommentableEntity, ActivityTypes]> => {
  const include = { association: 'collective', required: true };
  let activityType = ActivityTypes.COLLECTIVE_COMMENT_CREATED;
  let entity: CommentableEntity;

  if (commentValues.ExpenseId) {
    entity = (await Expense.findByPk(commentValues.ExpenseId, { include })) as Expense;
    activityType = ActivityTypes.EXPENSE_COMMENT_CREATED;
  } else if (commentValues.ConversationId) {
    entity = (await Conversation.findByPk(commentValues.ConversationId, { include })) as Conversation;
    activityType = ActivityTypes.CONVERSATION_COMMENT_CREATED;
  } else if (commentValues.UpdateId) {
    entity = (await Update.findByPk(commentValues.UpdateId, { include })) as Update;
    activityType = ActivityTypes.UPDATE_COMMENT_CREATED;
  } else if (commentValues.OrderId) {
    entity = (await models.Order.findByPk(commentValues.OrderId, { include })) as Order;
    activityType = ActivityTypes.ORDER_COMMENT_CREATED;
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

  const { ConversationId, ExpenseId, UpdateId, OrderId, html, type } = commentData;

  // Ensure at least (and only) one entity to comment is specified
  if ([ConversationId, ExpenseId, UpdateId, OrderId].filter(Boolean).length !== 1) {
    throw new ValidationFailed('You must specify one entity to comment');
  }

  // Load entity and its collective id
  const [commentedEntity, activityType] = await loadCommentedEntity(commentData);
  if (!commentedEntity) {
    throw new ValidationFailed("The item you're trying to comment doesn't exist or has been deleted.");
  }

  if (ExpenseId) {
    const expense = commentedEntity as Expense;
    if (!(await canCommentExpense(req, expense))) {
      throw new ValidationFailed('You are not allowed to comment on this expense');
    }
    if (type === CommentType.PRIVATE_NOTE && !(await canUseExpensePrivateNotes(req, expense))) {
      throw new Unauthorized('You need to be a host admin to post comments in this context');
    }
  } else if (UpdateId) {
    if (!(await canSeeUpdate(commentedEntity, req))) {
      throw new Unauthorized('You do not have the permission to post comments on this update');
    }
  } else if (OrderId) {
    if (!(await canCommentOrder(req, commentedEntity as Order))) {
      throw new Unauthorized('You do not have the permission to post comments on this order');
    }
    if (type !== CommentType.PRIVATE_NOTE) {
      throw new Unauthorized('Only private notes are allowed on orders');
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
    OrderId: comment.OrderId,
    data: {
      CommentId: comment.id,
      comment: { id: comment.id, html: comment.html, type: comment.type },
      FromCollectiveId: comment.FromCollectiveId,
      ExpenseId: comment.ExpenseId,
      UpdateId: comment.UpdateId,
      OrderId: comment.OrderId,
      ConversationId: comment.ConversationId,
    },
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
