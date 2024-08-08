import { pick } from 'lodash';

import ActivityTypes from '../../constants/activities';
import { Activity } from '../../models';

import * as ExpenseLib from './expenses';

export const sanitizeActivityData = async (req, activity): Promise<Partial<Activity['data']>> => {
  const toPick = [];
  if (activity.type === ActivityTypes.COLLECTIVE_EXPENSE_PAID) {
    toPick.push('isManualPayout');
  } else if (activity.type === ActivityTypes.COLLECTIVE_EXPENSE_ERROR) {
    if (activity.CollectiveId) {
      const collective = await req.loaders.Collective.byId.load(activity.CollectiveId);
      if (req.remoteUser?.isAdmin(collective.HostCollectiveId)) {
        toPick.push('error');
      }
    }
  } else if (
    [ActivityTypes.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE, ActivityTypes.COLLECTIVE_EXPENSE_PROCESSING].includes(
      activity.type,
    )
  ) {
    if (activity.ExpenseId) {
      const expense = await req.loaders.Expense.byId.load(activity.ExpenseId);
      if (expense && (await ExpenseLib.canSeeExpenseInvoiceInfo(req, expense))) {
        toPick.push('message', 'reference', 'estimatedDelivery');
      }
    }
  } else if (activity.type === ActivityTypes.COLLECTIVE_EXPENSE_MOVED) {
    toPick.push('movedFromCollective');
  } else if (
    [
      ActivityTypes.COLLECTIVE_MEMBER_INVITED,
      ActivityTypes.COLLECTIVE_CORE_MEMBER_INVITED,
      ActivityTypes.COLLECTIVE_CORE_MEMBER_INVITATION_DECLINED,
    ].includes(activity.type)
  ) {
    toPick.push('invitation.role');
  } else if (
    [
      ActivityTypes.COLLECTIVE_MEMBER_CREATED,
      ActivityTypes.COLLECTIVE_CORE_MEMBER_ADDED,
      ActivityTypes.COLLECTIVE_CORE_MEMBER_REMOVED,
      ActivityTypes.COLLECTIVE_CORE_MEMBER_EDITED,
    ].includes(activity.type)
  ) {
    toPick.push('member.role');
    toPick.push('invitation.role');
  } else if (activity.type === ActivityTypes.COLLECTIVE_EDITED) {
    const collective = await req.loaders.Collective.byId.load(activity.CollectiveId);
    if (req.remoteUser?.isAdminOfCollectiveOrHost(collective)) {
      toPick.push('previousData');
      toPick.push('newData');
    }
  } else if (activity.type === ActivityTypes.EXPENSE_COMMENT_CREATED && activity.ExpenseId) {
    const expense = await req.loaders.Expense.byId.load(activity.ExpenseId);
    if (expense && (await ExpenseLib.canComment(req, expense))) {
      toPick.push('comment');
    }
  } else if (activity.type === ActivityTypes.COLLECTIVE_UPDATE_PUBLISHED && !activity.data.update.isPrivate) {
    toPick.push('update.title', 'update.html');
  } else if (activity.type === ActivityTypes.ACCOUNTING_CATEGORIES_EDITED) {
    toPick.push('added', 'removed', 'edited');
  } else if ([ActivityTypes.VENDOR_EDITED, ActivityTypes.VENDOR_CREATED].includes(activity.type)) {
    const collective = await req.loaders.Collective.byId.load(activity.CollectiveId);
    if (req.remoteUser?.isAdminOfCollectiveOrHost(collective)) {
      toPick.push('vendor');
      toPick.push('previousData');
      toPick.push('newData');
    }
  } else if (
    [
      ActivityTypes.ORDER_PAYMENT_FAILED,
      ActivityTypes.PAYMENT_FAILED,
      ActivityTypes.ORDER_PROCESSING,
      ActivityTypes.PAYMENT_CREDITCARD_CONFIRMATION,
      ActivityTypes.ORDER_REVIEW_OPENED,
      ActivityTypes.ORDER_REVIEW_CLOSED,
      ActivityTypes.ORDER_DISPUTE_CREATED,
      ActivityTypes.ORDER_DISPUTE_CLOSED,
    ].includes(activity.type)
  ) {
    const [collective, fromCollective] = await req.loaders.Collective.byId.loadMany([
      activity.CollectiveId,
      activity.FromCollectiveId,
    ]);
    if (
      req.remoteUser?.isAdminOfCollectiveOrHost(collective) ||
      req.remoteUser?.isAdminOfCollectiveOrHost(fromCollective)
    ) {
      toPick.push('reason');
      toPick.push('errorMessage');
      toPick.push('paymentProcessorUrl');
    }
  }
  return pick(activity.data, toPick);
};
