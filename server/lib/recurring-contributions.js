import config from 'config';
import { get, omit } from 'lodash';
import moment from 'moment';
import { Op } from 'sequelize';

import activities from '../constants/activities';
import intervals from '../constants/intervals';
import status from '../constants/order_status';
import { PAYMENT_METHOD_TYPE } from '../constants/paymentMethods';
import roles from '../constants/roles';
import models from '../models';

import { notify } from './notifications/email';
import { FEATURE } from './allowed-features';
import emailLib from './email';
import logger from './logger';
import * as paymentsLib from './payments';
import { getTransactionPdf } from './pdf';
import { reportErrorToSentry } from './sentry';
import { getEditRecurringContributionsUrl } from './url-utils';
import { sleep, toIsoDateStr } from './utils';

/** Maximum number of attempts before an order gets cancelled. */
export const MAX_RETRIES = 6;

/** Find all orders with subscriptions that are active & due.
 *
 * Subscriptions are considered due if their `nextChargeDate` is
 * already past.
 */
export async function ordersWithPendingCharges({ limit, startDate } = {}) {
  return models.Order.findAndCountAll({
    where: {
      SubscriptionId: { [Op.ne]: null },
      deletedAt: null,
    },
    limit: limit,
    include: [
      { model: models.User, as: 'createdByUser' },
      { model: models.Collective, as: 'collective', required: true },
      { model: models.Collective, as: 'fromCollective', required: true },
      { model: models.PaymentMethod, as: 'paymentMethod' },
      { model: models.Tier, as: 'Tier' },
      {
        model: models.Subscription,
        where: {
          isActive: true,
          deletedAt: null,
          deactivatedAt: null,
          activatedAt: { [Op.lte]: startDate || new Date() },
          nextChargeDate: { [Op.lte]: startDate || new Date() },
          isManagedExternally: false,
        },
      },
    ],
  });
}

function hasReachedQuantity(order) {
  return order.Subscription.chargeNumber !== null && order.Subscription.chargeNumber === order.Subscription.quantity;
}

/** Process order and trigger result handlers.
 *
 * Uses `lib.payments.processOrder()` to charge subscription and
 * handle both success and failure of that processing.
 */
export async function processOrderWithSubscription(order, options) {
  // Refetch Order to be on the safe side (maybe it changed since it was retrieved)
  if (!options.dryRun) {
    const refetchOrder = await models.Order.findByPk(order.id);
    if (!refetchOrder || refetchOrder.deletedAt || refetchOrder.updatedAt.getTime() !== order.updatedAt.getTime()) {
      logger.info(`skipping order: ${order.id}, deleted, deactivated or updated since it was fetched.`);
      return;
    }
  }

  logger.info(
    `order: ${order.id}, subscription: ${order.Subscription.id}, ` +
      `attempt: #${order.Subscription.chargeRetryCount}, ` +
      `due: ${order.Subscription.nextChargeDate}`,
  );

  const csvEntry = {
    orderId: order.id,
    subscriptionId: order.Subscription.id,
    amount: order.totalAmount,
    from: order.fromCollective.slug,
    to: order.collective.slug,
    status: null,
    error: null,
    retriesBefore: order.Subscription.chargeRetryCount,
    retriesAfter: null,
    chargeDateBefore: dateFormat(order.Subscription.nextCharge),
    chargeDateAfter: null,
    nextPeriodStartBefore: dateFormat(order.Subscription.nextPeriodStart),
    nextPeriodStartAfter: null,
  };

  let orderProcessedStatus = 'unattempted';
  let collectiveIsArchived = false;
  let creditCardNeedsConfirmation = false;
  let transaction;

  if (!options.dryRun) {
    if (hasReachedQuantity(order)) {
      orderProcessedStatus = 'failure';
      csvEntry.error = 'Your subscription is over';
      cancelSubscription(order);
    } else if (order.collective.deactivatedAt) {
      // This means the collective has been archived and the subscription should be cancelled.
      orderProcessedStatus = 'failure';
      csvEntry.error = 'The collective has been archived';
      collectiveIsArchived = true;
      cancelSubscription(order);
    } else {
      try {
        transaction = await paymentsLib.processOrder(order);
        orderProcessedStatus = 'success';
      } catch (error) {
        if (error.stripeResponse && error.stripeResponse.paymentIntent) {
          creditCardNeedsConfirmation = true;
        }
        orderProcessedStatus = 'failure';
        csvEntry.error = error.message;
        order.status = status.ERROR;
        order.data = order.data || {};
        // TODO: we should consolidate on error and remove latestError
        order.data = { ...order.data, error: { message: error.message }, latestError: error.message };
      }

      order.Subscription.chargeRetryCount = getChargeRetryCount(orderProcessedStatus, order);
      order.Subscription = Object.assign(
        order.Subscription,
        getNextChargeAndPeriodStartDates(orderProcessedStatus, order),
      );

      if (orderProcessedStatus === 'success') {
        if (order.Subscription.chargeNumber !== null) {
          order.Subscription.chargeNumber += 1;
        }
        order.status = status.ACTIVE;
        // TODO: we should consolidate on error and remove latestError
        order.data = omit(order.data, ['error', 'latestError']);
      }
    }
  } else if (options.simulate) {
    await sleep(Math.random() * 1000 * 5);
  }

  csvEntry.status = orderProcessedStatus;
  csvEntry.retriesAfter = order.Subscription.chargeRetryCount;
  csvEntry.chargeDateAfter = dateFormat(order.Subscription.nextChargeDate);
  csvEntry.nextPeriodStartAfter = dateFormat(order.Subscription.nextPeriodStart);

  if (!options.dryRun) {
    try {
      if (collectiveIsArchived) {
        await createOrderCanceledArchivedCollectiveActivity(order);
      } else if (creditCardNeedsConfirmation) {
        if (order.Subscription.chargeRetryCount >= MAX_RETRIES) {
          await cancelSubscriptionAndNotifyUser(order);
        } else {
          order.data = order.data || {};
          order.data.needsConfirmation = true;
          await createPaymentCreditCardConfirmationActivity(order);
        }
      } else {
        await handleRetryStatus(order, transaction);
      }
    } catch (error) {
      console.log(`Error notifying order #${order.id} ${error}`);
      reportErrorToSentry(error, { severity: 'fatal', feature: FEATURE.RECURRING_CONTRIBUTIONS });
    } finally {
      await order.Subscription.save();
      await order.save();
    }
  }

  return csvEntry;
}

/** Standard way to format dates in this script */
function dateFormat(date) {
  return moment(date).format();
}

/** Handle processing result.
 *
 * The result of processing an order is stored within the field
 * `chargeRetryCount`. This function handles the following values for
 * this variable:
 *
 *   1. zero(0): Means success. The counter was reset after a
 *      successful processing.
 *
 *   2. MAX_RETRIES: The order will be cancelled because it reached
 *      the maximum number of retries and the payment method doesn't
 *      work.
 *
 *   3. WARN_USER: The last attempt failed. Warn user about the
 *      failure and allow them to update the payment method.
 */
export async function handleRetryStatus(order, transaction) {
  const errorMessage = get(order, 'data.error.message');
  switch (order.Subscription.chargeRetryCount) {
    case 0:
      return sendThankYouEmail(order, transaction);
    case 1:
    case 2:
      // Don't send an error in the 2 first attempts because the user is not responsible for these errors
      if (errorMessage) {
        if (errorMessage.includes('Payment Processing error') || errorMessage.includes('Internal Payment error')) {
          return Promise.resolve();
        }
      }
      return createPaymentFailedActivity(order, false);
    case MAX_RETRIES:
      return cancelSubscriptionAndNotifyUser(order);
    default:
      return createPaymentFailedActivity(order, false);
  }
}

/** Get the date an order should be charged again and it's next period start date
 *
 * The status defines how much time it will take until the same
 * subscription can be charged again. Currently supported status
 * values:
 *
 *   0. new: 1st day of the next month for monthly, 1st day of the
 *      same month of the next year for yearly.
 *   1. success: Increment date by 1 month for monthly or 1 year for
 *      yearly subscriptions
 *   2. failure: Two days after today.
 */
export function getNextChargeAndPeriodStartDates(status, order) {
  const initial = order.Subscription.nextPeriodStart || order.Subscription.createdAt;
  let nextChargeDate = moment(initial);
  const response = {};

  if (status === 'new' || status === 'success') {
    if (order.Subscription.interval === intervals.MONTH) {
      nextChargeDate.add(1, 'months');
    } else if (order.Subscription.interval === intervals.YEAR) {
      nextChargeDate.add(1, 'years');
    }

    // Set the next charge date to 2 months time if the subscription was made after 15th of the month.
    if (status === 'new' && order.Subscription.interval === intervals.MONTH && nextChargeDate.date() > 15) {
      nextChargeDate.add(1, 'months');
    }

    if (status === 'new') {
      nextChargeDate.startOf('month');
    }

    response.nextPeriodStart = nextChargeDate.toDate();
  } else if (status === 'failure') {
    if (order.Subscription.chargeRetryCount > 2) {
      // How do I remove time part from JavaScript date?
      // https://stackoverflow.com/questions/34722862/how-do-i-remove-time-part-from-javascript-date/34722927
      nextChargeDate = moment(new Date(new Date().toDateString())).add(5, 'days');
    } else {
      nextChargeDate = moment(new Date(new Date().toDateString())).add(2, 'days');
    }
  } else if (status === 'updated') {
    // used when user updates payment method
    nextChargeDate = moment(new Date()); // sets next charge date to now
  }
  response.nextChargeDate = nextChargeDate.toDate();
  return response;
}

/** Update counter that records retry attempts.
 *
 * When status is 'failure', `order.Subscription.chargeRetryCount` is
 * incremented by one. The counter is reset to zero if the status is
 * 'success'.
 */
export function getChargeRetryCount(status, order) {
  return status === 'success' || status === 'updated' ? 0 : order.Subscription.chargeRetryCount + 1;
}

/** Cancel subscription
 *
 * The `isActive` field will be set to false and the field
 * `deactivatedAt` will be updated with the current time.
 *
 * Notice that this function doesn't save the changes to the database
 * so a call to `order.Subscription.save()` is required after this
 * function.
 */
function cancelSubscription(order) {
  order.Subscription.isActive = false;
  order.Subscription.deactivatedAt = new Date();
  order.status = status.CANCELLED;
}

/** Group processed orders by their state
 *
 * This function groups a list of entries returned by the function
 * `processOrderWithSubscription()`. Although they do contain
 * information about the order processing, be aware that they aren't
 * really model instances.
 *
 * There are two variables within each entry that decide which group
 * they're going to belong to:
 *
 *  1. entry.status: If it's `success` then the entry is automatically
 *     categorized within the group `charged`. If the value of this
 *     field is `failure`, the other variable will be used in the
 *     decision.
 *
 *  2. entry.retriesAfter: If that's less than MAX_RETRIES than the
 *     entry is grouped under `past_due`. Otherwise, it's marked as
 *     `canceled`.
 */
export function groupProcessedOrders(orders) {
  return orders.reduce((map, value) => {
    const key = value.status === 'success' ? 'charged' : value.retriesAfter >= MAX_RETRIES ? 'canceled' : 'past_due';
    const group = map.get(key);
    if (group) {
      group.total += value.amount;
      group.entries.push(value);
    } else {
      map.set(key, {
        total: value.amount,
        entries: [value],
      });
    }
    return map;
  }, new Map());
}

/** Call cancelation function and then send confirmation email */
async function cancelSubscriptionAndNotifyUser(order) {
  cancelSubscription(order);
  return createPaymentFailedActivity(order, true);
}

/** Send `order.cancelled.archived.collective` email */
async function createOrderCanceledArchivedCollectiveActivity(order) {
  return models.Activity.create({
    type: activities.ORDER_CANCELED_ARCHIVED_COLLECTIVE,
    CollectiveId: order.CollectiveId,
    FromCollectiveId: order.FromCollectiveId,
    HostCollectiveId: order.collective?.approvedAt ? order.collective.HostCollectiveId : null,
    OrderId: order.id,
    data: {
      order: order.info,
      collective: order.collective.info,
      fromCollective: order.fromCollective.minimal,
    },
  });
}

/** Send `payment.failed` email */
async function createPaymentFailedActivity(order, lastAttempt) {
  const errorMessage = get(order, 'data.error.message');

  return models.Activity.create({
    type: activities.PAYMENT_FAILED,
    CollectiveId: order.CollectiveId,
    FromCollectiveId: order.FromCollectiveId,
    HostCollectiveId: order.collective?.approvedAt ? order.collective.HostCollectiveId : null,
    OrderId: order.id,
    data: {
      lastAttempt,
      order: order.info,
      collective: order.collective.info,
      fromCollective: order.fromCollective.minimal,
      subscriptionsLink: getEditRecurringContributionsUrl(order.fromCollective),
      errorMessage: errorMessage,
      isSystem: true,
    },
  });
}

/** Send `thankyou` email */
export async function sendThankYouEmail(order, transaction, isFirstPayment = false) {
  const attachments = [];
  const { collective, paymentMethod } = order;

  const user = await order.getUserForActivity();
  const host = await order.collective.getHostCollective();
  const parentCollective = await collective.getParentCollective();

  const data = {
    order: order.info,
    transaction: transaction ? transaction.info : { createdAt: new Date() },
    user: user.info,
    firstPayment: isFirstPayment,
    collective: order.collective.info,
    host: host ? host.info : {},
    fromCollective: order.fromCollective.minimal,
    config: { host: config.host },
    interval: order.Subscription?.interval || order.interval,
    subscriptionsLink: getEditRecurringContributionsUrl(order.fromCollective),
    customMessage: collective.settings?.customEmailMessage || parentCollective?.settings?.customEmailMessage,
  };

  // hit PDF service and get PDF (unless payment method type is gift card)
  if (transaction && paymentMethod?.type !== PAYMENT_METHOD_TYPE.GIFTCARD) {
    const transactionPdf = await getTransactionPdf(transaction, user);
    if (transactionPdf) {
      const createdAtString = toIsoDateStr(transaction.createdAt ? new Date(transaction.createdAt) : new Date());
      attachments.push({
        filename: `transaction_${collective.slug}_${createdAtString}_${transaction.uuid}.pdf`,
        content: transactionPdf,
      });
      data.transactionPdf = true;
    }

    if (transaction.hasPlatformTip()) {
      const platformTipTransaction = await transaction.getPlatformTipTransaction();
      if (platformTipTransaction) {
        const platformTipPdf = await getTransactionPdf(platformTipTransaction, user);
        if (platformTipPdf) {
          const createdAtString = toIsoDateStr(new Date(platformTipTransaction.createdAt));
          attachments.push({
            filename: `transaction_opencollective_${createdAtString}_${platformTipTransaction.uuid}.pdf`,
            content: platformTipPdf,
          });
          data.platformTipPdf = true;
        }
      }
    }
  }

  const activity = { type: activities.ORDER_CONFIRMED, data };
  return notify.collective(activity, {
    collectiveId: data.fromCollective.id,
    role: [roles.ACCOUNTANT, roles.ADMIN],
    from: emailLib.generateFromEmailHeader(order.collective.name),
    attachments,
  });
}

async function createPaymentCreditCardConfirmationActivity(order) {
  return models.Activity.create({
    type: activities.PAYMENT_CREDITCARD_CONFIRMATION,
    CollectiveId: order.CollectiveId,
    FromCollectiveId: order.FromCollectiveId,
    HostCollectiveId: order.collective.approvedAt ? order.collective.HostCollectiveId : null,
    OrderId: order.id,
    data: {
      order: order.info,
      collective: order.collective.info,
      fromCollective: order.fromCollective.minimal,
      confirmOrderLink: `${config.host.website}/${order.fromCollective.slug}/contributions/${order.id}/confirm`,
      paymentMethod: order.paymentMethod?.info,
    },
  });
}
