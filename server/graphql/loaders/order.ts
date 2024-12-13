import DataLoader from 'dataloader';

import ACTIVITY from '../../constants/activities';
import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import models, { Op, sequelize } from '../../models';
import Activity from '../../models/Activity';

import { sortResultsArray, sortResultsSimple } from './helpers';

export const PUBLIC_ORDER_ACTIVITIES = [
  ACTIVITY.COLLECTIVE_TRANSACTION_CREATED,
  ACTIVITY.ORDER_CANCELED_ARCHIVED_COLLECTIVE,
  ACTIVITY.ORDER_PENDING,
  ACTIVITY.ORDER_PENDING_CRYPTO, // deprecated
  ACTIVITY.ORDER_PENDING_CONTRIBUTION_NEW,
  ACTIVITY.ORDER_PROCESSING,
  ACTIVITY.ORDER_PAYMENT_FAILED,
  ACTIVITY.PAYMENT_FAILED,
  ACTIVITY.ORDER_THANKYOU,
  ACTIVITY.ORDER_PENDING_CREATED,
  ACTIVITY.ORDER_PENDING_FOLLOWUP,
  ACTIVITY.ORDER_PENDING_RECEIVED,
  ACTIVITY.ORDER_PENDING_EXPIRED,
  ACTIVITY.ORDER_UPDATED,
  ACTIVITY.SUBSCRIPTION_CANCELED,
  ACTIVITY.SUBSCRIPTION_PAUSED,
  ACTIVITY.SUBSCRIPTION_RESUMED,
  ACTIVITY.SUBSCRIPTION_CONFIRMED,
  ACTIVITY.SUBSCRIPTION_READY_TO_BE_RESUMED,
  ACTIVITY.ORDER_CANCELED_ARCHIVED_COLLECTIVE,
  ACTIVITY.ADDED_FUNDS_EDITED,
];

export const PRIVATE_ORDER_ACTIVITIES = [
  ACTIVITY.PAYMENT_CREDITCARD_CONFIRMATION,
  ACTIVITY.ORDERS_SUSPICIOUS,
  ACTIVITY.ORDER_PENDING_CONTRIBUTION_REMINDER,
  ACTIVITY.ORDER_REVIEW_OPENED,
  ACTIVITY.ORDER_REVIEW_CLOSED,
  ACTIVITY.ORDER_DISPUTE_CREATED,
  ACTIVITY.ORDER_DISPUTE_CLOSED,
  ACTIVITY.CONTRIBUTION_REJECTED,
];

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

export const generateOrderTotalContributedLoader = (): DataLoader<number, number> =>
  new DataLoader(async (orderIds: number[]) => {
    // The main assumption here is that Order.Currency is always the same as the CONTRIBUTION transactions
    const totalAmountsPerOrderId = (await models.Transaction.findAll({
      attributes: ['OrderId', [sequelize.fn('SUM', sequelize.col('amount')), 'totalAmount']],
      where: {
        OrderId: { [Op.in]: orderIds },
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        RefundTransactionId: null,
      },
      group: ['OrderId'],
      raw: true,
    })) as unknown as { OrderId: number; totalAmount: number }[];

    const orders = sortResultsSimple(orderIds, totalAmountsPerOrderId, result => result.OrderId);
    return orders.map(t => t?.totalAmount);
  });
