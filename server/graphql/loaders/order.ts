import DataLoader from 'dataloader';

import ACTIVITY from '../../constants/activities.js';
import models from '../../models/index.js';
import { Activity } from '../../models/Activity.js';

import { sortResultsArray } from './helpers.js';

export const PUBLIC_ORDER_ACTIVITIES = [
  ACTIVITY.COLLECTIVE_TRANSACTION_CREATED,
  ACTIVITY.ORDER_CANCELED_ARCHIVED_COLLECTIVE,
  ACTIVITY.ORDER_PENDING,
  ACTIVITY.ORDER_PENDING_CRYPTO,
  ACTIVITY.ORDER_PENDING_CONTRIBUTION_NEW,
  ACTIVITY.ORDER_PROCESSING,
  ACTIVITY.ORDER_PAYMENT_FAILED,
  ACTIVITY.ORDER_THANKYOU,
  ACTIVITY.ORDER_PENDING_CREATED,
  ACTIVITY.ORDER_PENDING_FOLLOWUP,
  ACTIVITY.ORDER_PENDING_RECEIVED,
];

export const PRIVATE_ORDER_ACTIVITIES = [ACTIVITY.ORDERS_SUSPICIOUS, ACTIVITY.ORDER_PENDING_CONTRIBUTION_REMINDER];

/**
 * Load all public activities for an order
 */
export const generateOrderActivitiesLoader = (): DataLoader<number, Activity[]> => {
  return new DataLoader(async (orderIDs: number[]) => {
    const activities = await models.Activity.findAll({
      where: { OrderId: orderIDs, type: [...PRIVATE_ORDER_ACTIVITIES, ...PUBLIC_ORDER_ACTIVITIES] },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });

    return sortResultsArray(orderIDs, activities, activity => activity.OrderId);
  });
};
