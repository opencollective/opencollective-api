import { randomUUID } from 'crypto';

import config from 'config';
import { get, omit } from 'lodash';
import moment from 'moment';
import { Op, QueryTypes, Transaction as SequelizeTransaction } from 'sequelize';

import activities from '../constants/activities';
import intervals from '../constants/intervals';
import status from '../constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../constants/paymentMethods';
import roles from '../constants/roles';
import type { Order } from '../models';
import models, { sequelize } from '../models';

import { notify } from './notifications/email';
import {
  mapErrorToType,
  MetricEvent,
  MetricFlow,
  MetricProvider,
  paymentServiceToMetricProvider,
  recordPaymentOutcome,
} from './sentry/metrics';
import { FEATURE } from './allowed-features';
import emailLib from './email';
import logger from './logger';
import { getOrderPaymentProcessingUrl, processOrder } from './payments';
import { getTransactionPdf } from './pdf';
import { reportErrorToSentry } from './sentry';
import { getEditRecurringContributionsUrl } from './url-utils';
import { sleep, toIsoDateStr } from './utils';

/** Maximum number of attempts before an order gets cancelled. */
export const MAX_RETRIES = 6;

type ProcessedOrderCsvEntry = {
  orderId: number;
  subscriptionId: number;
  amount: number;
  from: string;
  to: string;
  status: string | null;
  error: string | null;
  retriesBefore: number;
  retriesAfter: number | null;
  chargeDateBefore: string;
  chargeDateAfter: string | null;
  nextPeriodStartBefore: string;
  nextPeriodStartAfter: string | null;
};

type ChargeAndPeriodStartDates = {
  nextPeriodStart?: Date;
  nextChargeDate?: Date;
};

type ProcessedOrderActivityData = Record<string, unknown> & {
  fromCollective: { id: number };
};

/** Find all orders with subscriptions that are active & due.
 *
 * Subscriptions are considered due if their `nextChargeDate` is
 * already past.
 */
export async function ordersWithPendingCharges({
  limit,
  startDate,
  limitedToOrderIds = undefined,
}: { limit?: number; startDate?: Date; limitedToOrderIds?: number[] } = {}): Promise<{ count: number; rows: Order[] }> {
  return models.Order.findAndCountAll({
    where: {
      // CANCELLED orders must never be charged again: a bulk cancellation (tier deletion, account archive)
      // flips the order to CANCELLED and deactivates the subscription asynchronously, and a successful charge
      // would otherwise flip the order back to ACTIVE. See `findCancelledOrdersWithActiveSubscriptions` for
      // the detection of that inconsistent state.
      status: { [Op.notIn]: [status.PAUSED, status.PROCESSING, status.CANCELLED] },
      SubscriptionId: { [Op.ne]: null },
      deletedAt: null,
      ...(limitedToOrderIds && { id: { [Op.in]: limitedToOrderIds } }),
    },
    order: [
      ['createdAt', 'ASC'],
      ['id', 'ASC'],
    ],
    limit: limit,
    include: [
      { model: models.User, as: 'createdByUser' },
      {
        model: models.Collective,
        as: 'collective',
        required: true,
        where: {
          HostCollectiveId: { [Op.not]: null },
          isActive: true,
        },
      },
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

/**
 * Detects orders marked `CANCELLED` that still have an active subscription **and** are not pending deactivation.
 * This state should never happen: every cancellation path flags the order for asynchronous deactivation (see
 * `Order.stopActiveSubscriptions`) and `ordersWithPendingCharges` refuses to charge a CANCELLED order. When rows do
 * show up here, a cancellation path forgot to flag the order and the contribution is still live on the payment
 * provider side.
 *
 * Orders flagged for deactivation/pause are excluded on purpose: they are a normal transient state while
 * `cron/10mn/00-handle-batch-subscriptions-update` drains them. That job only looks at orders updated in the last
 * month though, so a flagged order older than that is stuck (e.g. a provider-side cancel that keeps failing) and is
 * reported. `needsAsyncReactivation` is not excluded: the job never reactivates a subscription that is still active.
 *
 * Used as a tripwire by `cron/hourly/00-charge-recurring-contributions.ts`: it never blocks charging, it only
 * makes the inconsistency visible.
 */
export async function findCancelledOrdersWithActiveSubscriptions({ limit = 100 } = {}): Promise<{
  count: number;
  orderIds: number[];
}> {
  const where = `
    "Orders"."status" = 'CANCELLED'
    AND "Orders"."deletedAt" IS NULL
    AND "Subscriptions"."deletedAt" IS NULL
    AND "Subscriptions"."isActive" IS TRUE
    AND NOT (
      "Orders"."updatedAt" > NOW() - INTERVAL '1 month'
      AND (
        COALESCE(("Orders"."data" ->> 'needsAsyncDeactivation')::BOOLEAN, FALSE)
        OR COALESCE(("Orders"."data" ->> 'needsAsyncPause')::BOOLEAN, FALSE)
      )
    )
  `;

  const [countRows, rows] = await Promise.all([
    sequelize.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM "Orders"
       INNER JOIN "Subscriptions" ON "Subscriptions".id = "Orders"."SubscriptionId"
       WHERE ${where}`,
      { type: QueryTypes.SELECT },
    ),
    sequelize.query<{ id: number }>(
      `SELECT "Orders".id
       FROM "Orders"
       INNER JOIN "Subscriptions" ON "Subscriptions".id = "Orders"."SubscriptionId"
       WHERE ${where}
       ORDER BY "Orders"."updatedAt" DESC
       LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { limit } },
    ),
  ]);

  return { count: countRows[0].count, orderIds: rows.map(row => row.id) };
}

/** Process order and trigger result handlers.
 *
 * Uses `lib.payments.processOrder()` to charge subscription and
 * handle both success and failure of that processing.
 */
export async function processOrderWithSubscription(
  order: Order,
  options: { dryRun?: boolean; simulate?: boolean },
): Promise<ProcessedOrderCsvEntry | undefined> {
  // Refetch Order to be on the safe side (maybe it changed since it was retrieved)
  if (!options.dryRun) {
    const refetchOrder = await models.Order.findByPk(order.id);
    if (!refetchOrder || refetchOrder.deletedAt || refetchOrder.updatedAt.getTime() !== order.updatedAt.getTime()) {
      logger.info(`skipping order: ${order.id}, deleted, deactivated or updated since it was fetched.`);
      return;
    }
  }

  let stripePaymentAttemptId: string;
  if (
    !options.dryRun &&
    !order.collective.deactivatedAt &&
    order.paymentMethod?.service === PAYMENT_METHOD_SERVICE.STRIPE
  ) {
    // Persist the processing invocation before calling Stripe. Unlike order.status, this survives
    // provider writes of stale order data and distinguishes an early failure from the previous attempt.
    stripePaymentAttemptId = randomUUID();
    const started = await sequelize.transaction(async transaction => {
      const currentOrder = await models.Order.findByPk(order.id, { transaction, lock: true });
      if (!currentOrder || currentOrder.updatedAt.getTime() !== order.updatedAt.getTime()) {
        return false;
      }
      const subscription = await models.Subscription.findByPk(order.SubscriptionId, { transaction, lock: true });
      const previousAttempt = subscription.data?.stripeRecurringPaymentAttempt;
      await subscription.update(
        {
          data: {
            ...subscription.data,
            stripeRecurringPaymentAttempt: {
              id: stripePaymentAttemptId,
              previousPaymentIntentId: currentOrder.data?.stripePaymentIntent?.id,
              previousFailureRecorded:
                previousAttempt?.outcome === 'failure' &&
                Boolean(previousAttempt.paymentIntentId) &&
                previousAttempt.paymentIntentId === currentOrder.data?.stripePaymentIntent?.id,
            },
          },
        },
        { transaction },
      );
      order.Subscription = subscription;
      return true;
    });
    if (!started) {
      return;
    }
  }

  logger.info(
    `order: ${order.id}, subscription: ${order.Subscription.id}, ` +
      `attempt: #${order.Subscription.chargeRetryCount}, ` +
      `due: ${order.Subscription.nextChargeDate}`,
  );

  const csvEntry: ProcessedOrderCsvEntry = {
    orderId: order.id,
    subscriptionId: order.Subscription.id,
    amount: order.totalAmount,
    from: order.fromCollective.slug,
    to: order.collective.slug,
    status: null,
    error: null,
    retriesBefore: order.Subscription.chargeRetryCount,
    retriesAfter: null,
    chargeDateBefore: dateFormat(order.Subscription.nextChargeDate),
    chargeDateAfter: null,
    nextPeriodStartBefore: dateFormat(order.Subscription.nextPeriodStart),
    nextPeriodStartAfter: null,
  };

  let orderProcessedStatus: 'unattempted' | 'processing' | 'failure' | 'success' = 'unattempted';
  let collectiveIsArchived = false;
  let creditCardNeedsConfirmation = false;
  let failureMetric: Parameters<typeof recordPaymentOutcome>[0];
  let failureAlreadyRecorded = false;
  let transaction: Awaited<ReturnType<typeof processOrder>>;

  if (!options.dryRun) {
    if (order.collective.deactivatedAt) {
      // This means the collective has been archived and the subscription should be cancelled.
      orderProcessedStatus = 'failure';
      csvEntry.error = 'The collective has been archived';
      collectiveIsArchived = true;
      cancelSubscription(order);
    } else {
      try {
        transaction = await processOrder(order);
        orderProcessedStatus = transaction ? 'success' : 'processing';
      } catch (error) {
        if (error.stripeResponse && error.stripeResponse.paymentIntent) {
          // Requires 3D Secure confirmation: not a terminal payment outcome, so it must not be counted
          creditCardNeedsConfirmation = true;
        } else {
          // Terminal failure of a payment attempt. Internal flows (opencollective service) are out of scope.
          const provider = paymentServiceToMetricProvider(order.paymentMethod?.service);
          if (provider === MetricProvider.STRIPE || provider === MetricProvider.PAYPAL) {
            failureMetric = {
              provider,
              flow: MetricFlow.CONTRIBUTION,
              method: order.paymentMethod.type,
              outcome: MetricEvent.FAILED,
              errorType: mapErrorToType(error),
            };
            if (!stripePaymentAttemptId) {
              recordPaymentOutcome(failureMetric);
              failureMetric = undefined;
            }
          }
        }
        orderProcessedStatus = 'failure';
        csvEntry.error = error.message;
        order.status = status.ERROR;
        order.data = order.data || {};
        // TODO: we should consolidate on error and remove latestError
        order.data = { ...order.data, error: { message: error.message }, latestError: error.message } as Order['data'];
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

        // Terminal success of a payment attempt (internal flows out of scope)
        const provider = paymentServiceToMetricProvider(order.paymentMethod?.service);
        if (provider === MetricProvider.STRIPE || provider === MetricProvider.PAYPAL) {
          recordPaymentOutcome({
            provider,
            flow: MetricFlow.CONTRIBUTION,
            method: order.paymentMethod.type,
            outcome: MetricEvent.SUCCEEDED,
          });
        }
      } else if (orderProcessedStatus === 'processing') {
        order.status = status.PROCESSING;
      }

      if (orderProcessedStatus === 'success' || orderProcessedStatus === 'processing') {
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
        if (orderProcessedStatus !== 'processing') {
          await handleRetryStatus(order, transaction);
        }
      }
    } catch (error) {
      reportErrorToSentry(error, { severity: 'fatal', feature: FEATURE.RECURRING_CONTRIBUTIONS });
    } finally {
      // Lock the order row so that a bulk cancellation cannot commit between the check and the save
      await sequelize.transaction(async transaction => {
        const currentOrder = await keepConcurrentCancellation(order, transaction);
        if (stripePaymentAttemptId) {
          const subscription = await models.Subscription.findByPk(order.SubscriptionId, { transaction, lock: true });
          const attempt = subscription.data?.stripeRecurringPaymentAttempt;
          if (attempt?.id !== stripePaymentAttemptId) {
            throw new Error(`Recurring payment attempt for order #${order.id} was superseded`);
          }
          if (attempt.outcome === 'failure') {
            // The webhook committed first. Do not overwrite its retry dates, cancellation or count,
            // even if the provider subsequently wrote a stale PROCESSING PaymentIntent snapshot.
            failureAlreadyRecorded = true;
            order.Subscription = subscription;
            order.status =
              attempt.isCancelled || currentOrder.status === status.CANCELLED ? status.CANCELLED : status.ERROR;
            order.data = currentOrder.data;
            csvEntry.status = 'failure';
            csvEntry.retriesAfter = subscription.chargeRetryCount;
            csvEntry.chargeDateAfter = dateFormat(subscription.nextChargeDate);
            csvEntry.nextPeriodStartAfter = dateFormat(subscription.nextPeriodStart);
            await order.save({ transaction });
            return;
          }
          order.Subscription.data = {
            ...subscription.data,
            stripeRecurringPaymentAttempt: {
              ...attempt,
              paymentIntentId: order.data?.stripePaymentIntent?.id,
              outcome: orderProcessedStatus === 'unattempted' ? undefined : orderProcessedStatus,
              isCancelled: order.status === status.CANCELLED,
              // 3DS confirmation consumes a retry, but is not itself a terminal payment failure.
              failureMetricClaimed: Boolean(failureMetric),
            },
          };
        }
        await order.Subscription.save({ transaction });
        await order.save({ transaction });
      });
    }
    if (failureMetric && !failureAlreadyRecorded) {
      recordPaymentOutcome(failureMetric);
    }
  }

  return csvEntry;
}

/**
 * A bulk cancellation (tier deletion, archived account) can happen while the order is being charged. Saving the
 * in-memory order as-is would then overwrite the `CANCELLED` status and drop `needsAsyncDeactivation`, and the
 * contribution would keep being charged. Keep the cancellation instead.
 */
async function keepConcurrentCancellation(order: Order, transaction: SequelizeTransaction): Promise<Order> {
  const currentOrder = await models.Order.findByPk(order.id, {
    attributes: ['id', 'status', 'data'],
    transaction,
    lock: true,
  });
  if (order.status !== status.CANCELLED && currentOrder?.status === status.CANCELLED) {
    order.status = status.CANCELLED;
    order.data = { ...order.data, ...currentOrder.data };
  }
  return currentOrder;
}

/** Standard way to format dates in this script */
function dateFormat(date: Date | string | null): string {
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
export async function handleRetryStatus(order: Order, transaction?: Awaited<ReturnType<typeof processOrder>>) {
  const errorMessage: string | undefined = get(order, 'data.error.message');
  switch (order.Subscription.chargeRetryCount) {
    case 0:
      return recordOrderProcessed(order, transaction);
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

/** Get the date an order should be charged again and its next period start date
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
 *   3. processing: No change
 */
export function getNextChargeAndPeriodStartDates(status: string, order: Order): ChargeAndPeriodStartDates {
  const initial = order.Subscription.nextPeriodStart || order.Subscription.createdAt;
  let nextChargeDate = moment(initial);
  const response: ChargeAndPeriodStartDates = {};

  if (status === 'processing') {
    return {
      nextPeriodStart: initial,
      nextChargeDate: order.Subscription.nextChargeDate,
    };
  }

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
export function getChargeRetryCount(status: string, order: Order): number {
  return status === 'success' || status === 'updated'
    ? 0
    : status === 'processing'
      ? order.Subscription.chargeRetryCount
      : order.Subscription.chargeRetryCount + 1;
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
function cancelSubscription(order: Order): void {
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
export function groupProcessedOrders(orders: ProcessedOrderCsvEntry[]) {
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
  }, new Map<string, { total: number; entries: ProcessedOrderCsvEntry[] }>());
}

/** Call cancelation function and then send confirmation email */
async function cancelSubscriptionAndNotifyUser(order: Order) {
  cancelSubscription(order);
  return createPaymentFailedActivity(order, true);
}

/** Send `order.cancelled.archived.collective` email */
async function createOrderCanceledArchivedCollectiveActivity(order: Order) {
  return models.Activity.create({
    type: activities.ORDER_CANCELED_ARCHIVED_COLLECTIVE,
    CollectiveId: order.CollectiveId,
    FromCollectiveId: order.FromCollectiveId,
    HostCollectiveId: order.collective.approvedAt ? order.collective.HostCollectiveId : null,
    OrderId: order.id,
    data: {
      order: order.info,
      collective: order.collective.info,
      fromCollective: order.fromCollective.minimal,
    },
  });
}

/** Send `payment.failed` email */
async function createPaymentFailedActivity(order: Order, lastAttempt: boolean) {
  const errorMessage = get(order, 'data.error.message');

  return models.Activity.create({
    type: activities.PAYMENT_FAILED,
    CollectiveId: order.CollectiveId,
    FromCollectiveId: order.FromCollectiveId,
    HostCollectiveId: order.collective.approvedAt ? order.collective.HostCollectiveId : null,
    OrderId: order.id,
    data: {
      lastAttempt,
      order: order.info,
      collective: order.collective.info,
      fromCollective: order.fromCollective.minimal,
      subscriptionsLink: getEditRecurringContributionsUrl(order.fromCollective),
      errorMessage: errorMessage,
      isSystem: true,
      reason: errorMessage,
      paymentProcessorUrl: await getOrderPaymentProcessingUrl(order),
    },
  });
}

/** Send `Thank you` (order.processed) email */
export async function recordOrderProcessed(
  order: Order,
  transaction?: Awaited<ReturnType<typeof processOrder>>,
  { isFirstPayment = false, skipEmail = false }: { isFirstPayment?: boolean; skipEmail?: boolean } = {},
): Promise<void> {
  const attachments = [];
  const { collective, paymentMethod } = order;

  const user = await order.getUserForActivity();
  const host = await order.collective.getHostCollective();
  const parentCollective = await collective.getParentCollective();

  const data: ProcessedOrderActivityData = {
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

  const activity = await order.createProcessedActivity({ user, data });

  if (!skipEmail) {
    await notify.collective(activity, {
      collectiveId: data.fromCollective.id,
      role: [roles.ACCOUNTANT, roles.ADMIN],
      from: emailLib.generateFromEmailHeader(order.collective.name),
      attachments,
    });
  }
}

async function createPaymentCreditCardConfirmationActivity(order: Order) {
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
      paymentProcessorUrl: await getOrderPaymentProcessingUrl(order),
    },
  });
}
