/**
 * Reconciles stale externally-managed (PayPal) contributions with their PayPal subscription.
 *
 * Cancellations are normally recorded from the `BILLING.SUBSCRIPTION.CANCELLED` webhook (see
 * `server/paymentProviders/paypal/webhook.ts`) but those events can be missed. This job looks for
 * contributions that are still marked as active in our database while their `nextChargeDate` is long
 * overdue, asks PayPal for the real status of the subscription and marks the contribution as
 * cancelled when PayPal confirms that it's `CANCELLED` or `EXPIRED`. Nothing is written when the
 * subscription is still active (or suspended) on PayPal: the reconciliation only ever follows
 * PayPal, it never guesses.
 *
 * Contributors are never emailed: this is a background reconciliation, not a user action. A
 * `SUBSCRIPTION_CANCELED` activity is still recorded (with `data.notify: false`) for the timeline
 * when the cancellation happened recently (see `ACTIVITY_LOOKBACK_DAYS`).
 */
import '../../server/env';

import moment from 'moment';

import ActivityTypes from '../../server/constants/activities';
import FEATURE from '../../server/constants/feature';
import ORDER_STATUS from '../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../server/constants/paymentMethods';
import logger from '../../server/lib/logger';
import { reportErrorToSentry, reportMessageToSentry } from '../../server/lib/sentry';
import { parseToBoolean } from '../../server/lib/utils';
import models, { Collective, Op, Order } from '../../server/models';
import {
  fetchPaypalSubscription,
  markPaypalSubscriptionAsCancelledInDb,
} from '../../server/paymentProviders/paypal/subscription';
import { PayPalSubscription } from '../../server/types/paypal';
import { onlyExecuteInProdOnMondays, runCronJob } from '../utils';

/** A contribution is considered stale when its `nextChargeDate` is older than this (in days) */
const DEFAULT_STALE_GRACE_DAYS = 3;

/** The `SUBSCRIPTION_CANCELED` activity is only recorded when the cancellation is more recent than this (in days) */
const ACTIVITY_LOOKBACK_DAYS = 30;

/** PayPal statuses that mean the subscription is definitely over */
const TERMINAL_PAYPAL_STATUSES = ['CANCELLED', 'EXPIRED'] as const;

type ReconciliationOutcome = 'cancelled' | 'cancelledWithActivity' | 'stillActive' | 'suspended' | 'skipped';

type RunOptions = {
  dryRun?: boolean;
  /** Only reconcile specific orders (mostly useful for tests and manual runs) */
  limitedToOrderIds?: number[];
};

const isHostSelected = (host: Collective): boolean => {
  const limitedToHostSlugs = process.env.HOST ? process.env.HOST.split(',') : null;
  const excludedHostSlugs = process.env.EXCLUDED_HOST ? process.env.EXCLUDED_HOST.split(',') : [];
  return (!limitedToHostSlugs || limitedToHostSlugs.includes(host.slug)) && !excludedHostSlugs.includes(host.slug);
};

/**
 * Records the cancellation on the timeline. `notify: false` prevents any dispatch (email, Slack,
 * webhooks): we don't want to notify the contributor for a cancellation we merely reconciled.
 */
const createSilentCancellationActivity = async (
  order: Order,
  host: Collective,
  {
    paypalStatus,
    statusUpdateTime,
    previousStatus,
  }: { paypalStatus: PayPalSubscription['status']; statusUpdateTime?: Date; previousStatus: Order['status'] },
): Promise<void> => {
  await models.Activity.create({
    type: ActivityTypes.SUBSCRIPTION_CANCELED,
    CollectiveId: order.CollectiveId,
    FromCollectiveId: order.FromCollectiveId,
    HostCollectiveId: host.id,
    OrderId: order.id,
    UserId: order.CreatedByUserId,
    data: {
      notify: false, // Background reconciliation: the contributor is never emailed
      subscription: order.Subscription,
      collective: order.collective.minimal,
      user: order.createdByUser?.minimal,
      fromCollective: order.fromCollective.minimal,
      host: host.minimal,
      order: order.info,
      tier: order.Tier?.info,
      previousStatus,
      reason: 'Contribution cancelled on PayPal',
      paypalStatus,
      paypalStatusUpdateTime: statusUpdateTime,
    },
  });
};

const markContributionAsCancelled = async (
  order: Order,
  host: Collective,
  { paypalSubscription, dryRun }: { paypalSubscription: PayPalSubscription; dryRun: boolean },
): Promise<ReconciliationOutcome> => {
  const statusUpdateTime = paypalSubscription.status_update_time
    ? new Date(paypalSubscription.status_update_time)
    : null;
  const cancelledRecently = Boolean(
    statusUpdateTime && moment(statusUpdateTime).isAfter(moment().subtract(ACTIVITY_LOOKBACK_DAYS, 'days')),
  );
  const previousStatus = order.status;

  if (dryRun) {
    logger.info(
      `DRY RUN: would mark order #${order.id} as cancelled (PayPal status: ${paypalSubscription.status}, cancelled at ${statusUpdateTime})`,
    );
  } else {
    await markPaypalSubscriptionAsCancelledInDb(order, {
      statusUpdateTime,
      orderData: {
        previousStatus,
        cancelledFromPayPalReconciliation: true,
        paypalStatusUpdateTime: statusUpdateTime,
      },
      subscriptionData: { deactivatedFromPayPalReconciliation: true },
    });

    // Only record recent cancellations on the timeline: reconciling an old one is not news to anyone
    if (cancelledRecently) {
      await createSilentCancellationActivity(order, host, {
        paypalStatus: paypalSubscription.status,
        statusUpdateTime,
        previousStatus,
      });
    }
  }

  return cancelledRecently ? 'cancelledWithActivity' : 'cancelled';
};

/**
 * Checks a single stale contribution against PayPal and reconciles it if PayPal confirms that the
 * subscription is over.
 */
const reconcileStaleContribution = async (
  order: Order,
  { dryRun }: { dryRun: boolean },
): Promise<ReconciliationOutcome> => {
  const subscription = order.Subscription;
  const paymentMethod = order.paymentMethod;

  // When a contribution is edited, the subscription is re-pointed to a new PayPal subscription after
  // the previous one got cancelled on PayPal (see `setupPaypalSubscriptionForOrder`). Such rows are
  // not stale, they just don't reference the active subscription anymore.
  if (paymentMethod.token !== subscription.paypalSubscriptionId) {
    logger.warn(
      `Skipping order #${order.id}: payment method token (${paymentMethod.token}) does not match the subscription's PayPal ID (${subscription.paypalSubscriptionId})`,
    );
    return 'skipped';
  }

  const host = await order.collective.getHostCollective();
  if (!host) {
    logger.warn(`Skipping order #${order.id}: collective ${order.collective.slug} has no host`);
    return 'skipped';
  } else if (!isHostSelected(host)) {
    return 'skipped';
  }

  // PayPal is the source of truth: we only mark the contribution as cancelled if PayPal confirms it
  const paypalSubscription = await fetchPaypalSubscription(host, subscription.paypalSubscriptionId);
  if (TERMINAL_PAYPAL_STATUSES.includes(paypalSubscription.status as (typeof TERMINAL_PAYPAL_STATUSES)[number])) {
    const msg = `Order #${order.id}: PayPal subscription ${subscription.paypalSubscriptionId} is ${paypalSubscription.status} on PayPal, marking the contribution as cancelled`;
    logger.info(dryRun ? `DRY RUN: ${msg}` : msg);
    return markContributionAsCancelled(order, host, { paypalSubscription, dryRun });
  } else if (paypalSubscription.status === 'SUSPENDED') {
    reportMessageToSentry(`PayPal subscription is suspended while the contribution is still active`, {
      feature: FEATURE.PAYPAL_DONATIONS,
      severity: 'warning',
      extra: { orderId: order.id, paypalSubscriptionId: subscription.paypalSubscriptionId },
    });
    return 'suspended';
  } else {
    logger.info(
      `Order #${order.id}: PayPal subscription ${subscription.paypalSubscriptionId} is still ${paypalSubscription.status} on PayPal ` +
        `(next billing time: ${paypalSubscription.billing_info?.next_billing_time || 'unknown'}, ` +
        `failed payments: ${paypalSubscription.billing_info?.failed_payments_count ?? 'unknown'})`,
    );
    return 'stillActive';
  }
};

export const run = async (options: RunOptions = {}): Promise<void> => {
  const dryRun = options.dryRun ?? (process.env.DRY_RUN ? parseToBoolean(process.env.DRY_RUN) : false);
  const graceDays = process.env.PAYPAL_STALE_SUBSCRIPTION_GRACE_DAYS
    ? parseInt(process.env.PAYPAL_STALE_SUBSCRIPTION_GRACE_DAYS, 10)
    : DEFAULT_STALE_GRACE_DAYS;
  const staleBefore = moment().subtract(graceDays, 'days').toDate();

  const orders = await models.Order.findAll({
    where: {
      status: ORDER_STATUS.ACTIVE,
      SubscriptionId: { [Op.ne]: null },
      ...(options.limitedToOrderIds ? { id: options.limitedToOrderIds } : null),
    },
    include: [
      {
        association: 'Subscription',
        required: true,
        where: {
          isActive: true,
          isManagedExternally: true,
          paypalSubscriptionId: { [Op.ne]: null },
          nextChargeDate: { [Op.lt]: staleBefore },
        },
      },
      {
        association: 'paymentMethod',
        required: true,
        where: { service: PAYMENT_METHOD_SERVICE.PAYPAL, type: PAYMENT_METHOD_TYPE.SUBSCRIPTION },
      },
      { association: 'collective', required: true },
      { association: 'fromCollective', required: true },
      { association: 'createdByUser', required: false },
      { association: 'Tier', required: false },
    ],
    order: [['createdAt', 'ASC']],
  });

  logger.info(
    `Checking ${orders.length} stale externally-managed contributions (nextChargeDate older than ${graceDays} days)`,
  );

  const summary: Record<ReconciliationOutcome | 'error', number> = {
    cancelled: 0,
    cancelledWithActivity: 0,
    stillActive: 0,
    suspended: 0,
    skipped: 0,
    error: 0,
  };

  for (const order of orders) {
    try {
      summary[await reconcileStaleContribution(order, { dryRun })]++;
    } catch (e) {
      summary.error++;
      logger.error(`Error while reconciling order #${order.id}: ${e.message}`);
      reportErrorToSentry(e, {
        feature: FEATURE.PAYPAL_DONATIONS,
        extra: { orderId: order.id, paypalSubscriptionId: order.Subscription?.paypalSubscriptionId },
      });
    }
  }

  logger.info(`Done. Summary: ${JSON.stringify(summary)}`);
};

if (require.main === module) {
  // Only run on Mondays in production (since Heroku scheduler only has daily/hourly options)
  if (!parseToBoolean(process.env.OFFCYCLE)) {
    onlyExecuteInProdOnMondays();
  }

  runCronJob('reconcile-stale-paypal-subscriptions', run, 60 * 30, { feature: FEATURE.PAYPAL_DONATIONS }); // 30 minutes timeout
}
