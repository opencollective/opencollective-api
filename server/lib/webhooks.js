import { pick } from 'lodash';

import { activities } from '../constants';
import { idEncode, IDENTIFIER_TYPES } from '../graphql/v2/identifiers';

import { formatCurrency } from './utils';

/**
 * Filter collective public information, returning a minimal subset for incognito users
 */
const getCollectiveInfo = collective => {
  if (!collective) {
    return null;
  } else if (collective.isIncognito) {
    return pick(collective, ['type', 'name', 'image', 'previewImage']);
  } else {
    return {
      idV2: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT),
      ...pick(collective, [
        'id',
        'type',
        'slug',
        'name',
        'company',
        'website',
        'twitterHandle',
        'githubHandle',
        'repositoryUrl',
        'description',
        'previewImage',
        'image',
      ]),
    };
  }
};

const getTierInfo = tier => {
  if (!tier) {
    return null;
  } else {
    return {
      idV2: idEncode(tier.id, IDENTIFIER_TYPES.TIER),
      ...pick(tier, ['id', 'name', 'amount', 'currency', 'description', 'maxQuantity']),
    };
  }
};

const getOrderInfo = order => {
  if (!order) {
    return null;
  } else {
    return {
      idV2: idEncode(order.id, IDENTIFIER_TYPES.ORDER),
      ...pick(order, [
        'id',
        'totalAmount',
        'currency',
        'description',
        'tags',
        'interval',
        'createdAt',
        'quantity',
        'FromCollectiveId',
        'TierId',
      ]),
    };
  }
};

const getExpenseInfo = expense => {
  if (!expense) {
    return null;
  } else {
    return {
      idV2: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
      ...pick(expense, ['id', 'description', 'amount', 'currency']),
    };
  }
};

const getUpdateInfo = update => {
  if (!update) {
    return null;
  } else {
    return {
      idV2: idEncode(update.id, IDENTIFIER_TYPES.UPDATE),
      ...pick(update, ['html', 'title', 'slug', 'tags', 'isPrivate']),
    };
  }
};

const expenseActivities = [
  activities.COLLECTIVE_EXPENSE_CREATED,
  activities.COLLECTIVE_EXPENSE_DELETED,
  activities.COLLECTIVE_EXPENSE_UPDATED,
  activities.COLLECTIVE_EXPENSE_REJECTED,
  activities.COLLECTIVE_EXPENSE_APPROVED,
  activities.COLLECTIVE_EXPENSE_RE_APPROVAL_REQUESTED,
  activities.COLLECTIVE_EXPENSE_UNAPPROVED,
  activities.COLLECTIVE_EXPENSE_PAID,
  activities.COLLECTIVE_EXPENSE_MARKED_AS_UNPAID,
  activities.COLLECTIVE_EXPENSE_PROCESSING,
  activities.COLLECTIVE_EXPENSE_ERROR,
  activities.COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT,
  activities.COLLECTIVE_EXPENSE_MARKED_AS_SPAM,
];

/**
 * Sanitize an activity to make it suitable for posting on external webhooks
 */
export const sanitizeActivity = activity => {
  // Fields commons to all activity types
  const cleanActivity = pick(activity, ['createdAt', 'id', 'type', 'CollectiveId']);
  const type = cleanActivity.type;

  // Alway have an empty data object for activity
  cleanActivity.data = {};

  if (!activity.data) {
    return cleanActivity;
  }

  // Filter data based on activity type
  if (type === activities.COLLECTIVE_TRANSACTION_CREATED) {
    cleanActivity.data = pick(activity.data, ['transaction']); // It's safe to pick the entire transaction as it's added there through `transaction.info`, which only contains public fields
    cleanActivity.data.fromCollective = getCollectiveInfo(activity.data.fromCollective);
    cleanActivity.data.collective = getCollectiveInfo(activity.data.collective);
  } else if (type === activities.COLLECTIVE_UPDATE_PUBLISHED) {
    cleanActivity.data = { update: getUpdateInfo(activity.data.update) };
  } else if (expenseActivities.includes(type)) {
    cleanActivity.data = {
      expense: getExpenseInfo(activity.data.expense),
      fromCollective: getCollectiveInfo(activity.data.fromCollective),
      collective: getCollectiveInfo(activity.data.collective),
    };
  } else if (type === activities.COLLECTIVE_MEMBER_CREATED) {
    cleanActivity.data = pick(activity.data, ['member.role', 'member.description', 'member.since']);
    cleanActivity.data.order = getOrderInfo(activity.data.order);
    cleanActivity.data.member.memberCollective = getCollectiveInfo(activity.data.member.memberCollective);
    cleanActivity.data.member.tier = getTierInfo(activity.data.member.tier);
  } else if (type === activities.TICKET_CONFIRMED) {
    cleanActivity.data = pick(activity.data, ['recipient.name']);
    cleanActivity.data.tier = getTierInfo(activity.data.tier);
    cleanActivity.data.order = getOrderInfo(activity.data.order);
  } else if (type === activities.SUBSCRIPTION_CANCELED || type === activities.SUBSCRIPTION_PAUSED) {
    cleanActivity.data = pick(activity.data, ['subscription.id']);
    cleanActivity.data.order = getOrderInfo(activity.data.order);
    cleanActivity.data.tier = getTierInfo(activity.data.tier);
  }

  return cleanActivity;
};

const enrichActivityData = data => {
  if (!data) {
    return null;
  }

  Object.entries(data).forEach(([key, value]) => {
    if (value && typeof value === 'object') {
      enrichActivityData(value);
    } else if (key === 'amount' || key === 'totalAmount') {
      const amount = value;
      const currency = data['currency'];
      const interval = data['interval'];
      data.formattedAmount = currency ? formatCurrency(amount, currency, 2) : (amount / 100).toFixed(2);
      data.formattedAmountWithInterval = interval ? `${data.formattedAmount} / ${interval}` : data.formattedAmount;
    }
  });
};

/**
 * Adds user-friendly fields to an activity. Mutates activity.
 */
export const enrichActivity = activity => {
  enrichActivityData(activity.data);
  return activity;
};
