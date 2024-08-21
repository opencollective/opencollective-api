import { pick } from 'lodash';

import ActivityTypes from '../../constants/activities';
import { mustBeLoggedInTo } from '../../lib/auth';
import models, { HostApplication } from '../../models';
import Comment, { CommentType } from '../../models/Comment';
import Conversation from '../../models/Conversation';
import Expense from '../../models/Expense';
import Order from '../../models/Order';
import Update from '../../models/Update';
import { canComment as canCommentOrder } from '../common/orders';
import { NotFound, Unauthorized, ValidationFailed } from '../errors';

import { canComment as canCommentExpense, canUsePrivateNotes as canUseExpensePrivateNotes } from './expenses';
import { canCommentHostApplication } from './host-applications';
import { checkRemoteUserCanUseComment } from './scope-check';
import { canSeeUpdate } from './update';

type CommentableEntity = Update | Expense | Conversation | Order | HostApplication;

type CommentAssociationData = Pick<
  Comment,
  'UpdateId' | 'ExpenseId' | 'OrderId' | 'ConversationId' | 'HostApplicationId'
>;

const loadCommentedEntity = async (
  commentValues: CommentAssociationData,
  loaders: any,
): Promise<[CommentableEntity, ActivityTypes, Record<string, any>]> => {
  let activityType = ActivityTypes.COLLECTIVE_COMMENT_CREATED;
  let entity: CommentableEntity;
  let activityData: Record<string, any> = {};

  if (commentValues.ExpenseId) {
    activityType = ActivityTypes.EXPENSE_COMMENT_CREATED;
    entity = (await loaders.Expense.byId.load(commentValues.ExpenseId)) as Expense;
    if (entity) {
      entity.collective = await loaders.Collective.byId.load(entity.CollectiveId);
      if (!entity.collective) {
        return [null, activityType, activityData];
      }
    }
  } else if (commentValues.ConversationId) {
    activityType = ActivityTypes.CONVERSATION_COMMENT_CREATED;
    entity = (await loaders.Conversation.byId.load(commentValues.ConversationId)) as Conversation;
    if (entity) {
      entity.collective = await loaders.Collective.byId.load(entity.CollectiveId);
      if (!entity.collective) {
        return [null, activityType, activityData];
      }
    }
  } else if (commentValues.UpdateId) {
    activityType = ActivityTypes.UPDATE_COMMENT_CREATED;
    entity = (await loaders.Update.byId.load(commentValues.UpdateId)) as Update;
    if (entity) {
      entity.collective = await loaders.Collective.byId.load(entity.CollectiveId);
      if (!entity.collective) {
        return [null, activityType, activityData];
      }
    }
  } else if (commentValues.OrderId) {
    activityType = ActivityTypes.ORDER_COMMENT_CREATED;
    entity = (await loaders.Order.byId.load(commentValues.OrderId)) as Order;
    if (entity) {
      entity.collective = await loaders.Collective.byId.load(entity.CollectiveId);
      if (!entity.collective) {
        return [null, activityType, activityData];
      }
    }
  } else if (commentValues.HostApplicationId) {
    entity = (await models.HostApplication.findByPk(commentValues.HostApplicationId)) as HostApplication;
    activityType = ActivityTypes.HOST_APPLICATION_COMMENT_CREATED;
    entity.host = await entity.getHost();
    entity.collective = await entity.getCollective();
    activityData = {
      host: entity.host?.info,
      collective: entity.collective?.info,
    };
  }

  return [entity, activityType, activityData];
};

const getCommentPermissionsError = async (req, commentedEntity, commentType) => {
  if (commentedEntity instanceof Expense) {
    if (!(await canCommentExpense(req, commentedEntity))) {
      return new Unauthorized('You are not allowed to comment on this expense');
    } else if (commentType === CommentType.PRIVATE_NOTE && !(await canUseExpensePrivateNotes(req, commentedEntity))) {
      return new Unauthorized('You need to be a host admin to post comments in this context');
    }
  } else if (commentedEntity instanceof Update) {
    if (!(await canSeeUpdate(req, commentedEntity))) {
      return new Unauthorized('You do not have the permission to post comments on this update');
    }
  } else if (commentedEntity instanceof Order) {
    if (!(await canCommentOrder(req, commentedEntity))) {
      return new Unauthorized('You do not have the permission to post comments on this order');
    } else if (commentType !== CommentType.PRIVATE_NOTE) {
      return new Unauthorized('Only private notes are allowed on orders');
    }
  } else if (commentedEntity instanceof HostApplication) {
    if (!(await canCommentHostApplication(req, commentedEntity as HostApplication))) {
      return new Unauthorized('You do not have the permission to post comments on this host application');
    }
  }
};

export async function canSeeComment(req, comment: Comment): Promise<boolean> {
  const [entity] = await loadCommentedEntity(comment, req.loaders);
  const error = await getCommentPermissionsError(req, entity, comment.type);
  return !error;
}

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

  const { ConversationId, ExpenseId, UpdateId, OrderId, HostApplicationId, html, type } = commentData;

  // Ensure at least (and only) one entity to comment is specified
  if ([ConversationId, ExpenseId, UpdateId, OrderId, HostApplicationId].filter(Boolean).length !== 1) {
    throw new ValidationFailed('You must specify one entity to comment');
  }

  // Load entity and its collective id
  const [commentedEntity, activityType, activityData] = await loadCommentedEntity(commentData, req.loaders);
  if (!commentedEntity) {
    throw new ValidationFailed("The item you're trying to comment doesn't exist or has been deleted.");
  }

  // Check for permissions
  const error = await getCommentPermissionsError(req, commentedEntity, type);
  if (error) {
    throw error;
  }

  // Create comment
  const comment = await Comment.create({
    CreatedByUserId: remoteUser.id,
    FromCollectiveId: remoteUser.CollectiveId,
    CollectiveId: commentedEntity.collective.id,
    ExpenseId,
    UpdateId,
    ConversationId,
    HostApplicationId,
    html, // HTML is sanitized at the model level, no need to do it here
    type,
  });

  // Create activity
  await models.Activity.create({
    type: activityType,
    UserId: comment.CreatedByUserId,
    CollectiveId: comment.CollectiveId,
    FromCollectiveId: comment.FromCollectiveId,
    HostCollectiveId: 'HostCollectiveId' in commentedEntity ? commentedEntity.HostCollectiveId : null,
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
      HostApplicationId: comment.HostApplicationId,
      ...activityData,
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
