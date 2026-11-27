/**
 * Disconnects a host from PayPal and cancels the recurring PayPal contributions it owns on PayPal.
 *
 * See https://github.com/opencollective/opencollective/issues/9159
 *
 * Usage:
 *   npm run script scripts/paypal/disconnect-host.ts <hostSlug> [--execute] [--orders <ids>] [--force-disconnect]
 *
 * - Dry run by default: prints everything it would do. Only read-only (`GET`) requests are sent to PayPal.
 * - `--execute`: cancels the subscriptions on PayPal, writes to the database and (unless `--orders`) removes the
 *   webhooks and the PayPal connected account(s) of the host.
 * - `--orders 1,2,3`: only process these orders, and never disconnect the host. Useful to cancel single
 *   subscriptions on a host that stays connected.
 * - On a connected host, orders that need a manual review (PayPal error or unknown status) are left untouched in the
 *   database and the host is not disconnected, so that a re-run can retry them. `--force-disconnect` cancels them in
 *   the database and disconnects the host anyway (they may still be live on PayPal).
 *
 * Selection: orders (any status) with an active PayPal subscription whose "PayPal host" is the target. The PayPal host
 * is the host of the most recent `CONTRIBUTION`/`CREDIT` transaction of the order, or the collective's current host
 * if there is none (see `server/paymentProviders/paypal/subscription-host.ts`).
 *
 * Contributors are never notified: a `SUBSCRIPTION_CANCELED` activity is recorded for the timeline with
 * `data.notify: false`. The script is idempotent: processed subscriptions are inactive and won't be selected again.
 */

import '../../server/env';

import { Command } from 'commander';
import { countBy, get, omit } from 'lodash';

import ActivityTypes from '../../server/constants/activities';
import OrderStatuses from '../../server/constants/order-status';
import { TransactionKind } from '../../server/constants/transaction-kind';
import { TransactionTypes } from '../../server/constants/transactions';
import logger from '../../server/lib/logger';
import {
  deletePaypalWebhook,
  getHostPaypalAccount,
  isOpenCollectiveWebhook,
  listPaypalWebhooks,
} from '../../server/lib/paypal';
import { sleep } from '../../server/lib/utils';
import models, { Collective, Op, sequelize } from '../../server/models';
import Order from '../../server/models/Order';
import { paypalRequest } from '../../server/paymentProviders/paypal/api';
import { cancelPaypalSubscription } from '../../server/paymentProviders/paypal/subscription';
import { findOrderIdsWithActivePaypalSubscriptionForHost } from '../../server/paymentProviders/paypal/subscription-host';
import { PayPalSubscription } from '../../server/types/paypal';

export const CANCELLATION_REASON = 'The fiscal host is no longer accepting PayPal contributions';

/** PayPal statuses for which the subscription can still be charged, and must therefore be cancelled */
const CANCELLABLE_PAYPAL_STATUSES = ['ACTIVE', 'SUSPENDED', 'APPROVAL_PENDING', 'APPROVED'];

/** PayPal statuses for which the subscription is over */
const TERMINAL_PAYPAL_STATUSES = ['CANCELLED', 'EXPIRED'];

/** Order flags handled by `cron/10mn/00-handle-batch-subscriptions-update.ts` that must be cleared */
const ASYNC_FLAGS = ['needsAsyncDeactivation', 'needsAsyncPause', 'needsAsyncReactivation'];

type PaypalOutcome =
  /** The subscription was active on PayPal and got cancelled */
  | 'cancelledOnPaypal'
  /** The subscription was already cancelled/expired on PayPal */
  | 'alreadyCancelled'
  /** The host has no PayPal connection: nothing could be done on PayPal */
  | 'hostNotConnected'
  /** PayPal returned an error or an unknown status: someone needs to check on PayPal */
  | 'manualReview';

type OrderResult = {
  orderId: number;
  previousStatus: string;
  paypalSubscriptionId: string;
  paypalStatus?: string;
  paypalOutcome: PaypalOutcome;
  error?: string;
};

type DisconnectHostReport = {
  host: { id: number; slug: string };
  dryRun: boolean;
  isConnected: boolean;
  orders: OrderResult[];
  cancelledOnPaypal: number[];
  alreadyCancelled: number[];
  hostNotConnected: number[];
  manualReview: number[];
  cancelledInDb: number[];
  /** Orders left untouched in the DB so that a re-run can retry them on PayPal */
  skippedInDb: number[];
  /** True when the host was not disconnected because some orders need a manual review */
  disconnectSkipped: boolean;
  deletedWebhookIds: string[];
  deletedConnectedAccountIds: number[];
};

type DisconnectHostOptions = {
  hostSlug: string;
  /** Write to the DB and call PayPal (except `GET`s). Defaults to false (dry run). */
  execute?: boolean;
  /** Only process these orders, and never disconnect the host */
  orderIds?: number[];
  /** Cancel `manualReview` orders in the DB and disconnect the host even if some PayPal requests failed */
  forceDisconnect?: boolean;
  /** Delay between PayPal requests, to prevent rate limiting */
  throttleMs?: number;
};

const log = (dryRun: boolean, message: string) => logger.info(dryRun ? `[DRY RUN] ${message}` : message);

const loadOrders = async (orderIds: number[]): Promise<Order[]> => {
  if (!orderIds.length) {
    return [];
  }

  return models.Order.findAll({
    where: { id: orderIds },
    include: [
      { association: 'Subscription', required: true },
      { association: 'collective', required: true },
      { association: 'fromCollective', required: true },
      { association: 'createdByUser', required: false },
      { association: 'Tier', required: false },
    ],
    order: [['id', 'ASC']],
  });
};

const getLastChargeDates = async (orderIds: number[]): Promise<Record<number, Date>> => {
  if (!orderIds.length) {
    return {};
  }

  const rows = (await models.Transaction.findAll({
    raw: true,
    attributes: ['OrderId', [sequelize.fn('MAX', sequelize.col('createdAt')), 'lastChargeAt']],
    where: { OrderId: orderIds, kind: TransactionKind.CONTRIBUTION, type: TransactionTypes.CREDIT },
    group: ['OrderId'],
  })) as unknown as Array<{ OrderId: number; lastChargeAt: Date }>;

  return Object.fromEntries(rows.map(row => [row.OrderId, row.lastChargeAt]));
};

const printSummary = async (host: Collective, isConnected: boolean, orders: Order[], dryRun: boolean) => {
  const lastChargeDates = await getLastChargeDates(orders.map(o => o.id));
  const lastCharges = Object.values(lastChargeDates).map(d => new Date(d).getTime());
  const lastCharge = lastCharges.length ? new Date(Math.max(...lastCharges)).toISOString() : 'never';
  log(dryRun, `Host: @${host.slug} (#${host.id})`);
  log(dryRun, `PayPal connected: ${isConnected ? 'yes' : 'no'}`);
  log(dryRun, `Active PayPal subscriptions: ${orders.length}`);
  log(dryRun, `By order status: ${JSON.stringify(countBy(orders, 'status'))}`);
  log(dryRun, `Last charge: ${lastCharge}`);
  for (const order of orders) {
    const lastChargeAt = lastChargeDates[order.id] ? new Date(lastChargeDates[order.id]).toISOString() : 'never';
    log(
      dryRun,
      `  - Order #${order.id} (${order.status}) from @${order.fromCollective.slug} to @${order.collective.slug}, ` +
        `PayPal subscription ${order.Subscription.paypalSubscriptionId}, last charge: ${lastChargeAt}`,
    );
  }
};

/**
 * Checks the subscription on PayPal and cancels it if it can still be charged.
 */
const cancelOnPaypal = async (
  order: Order,
  host: Collective,
  { dryRun }: { dryRun: boolean },
): Promise<Pick<OrderResult, 'paypalOutcome' | 'paypalStatus' | 'error'>> => {
  const paypalSubscriptionId = order.Subscription.paypalSubscriptionId;
  let paypalSubscription: PayPalSubscription;
  try {
    paypalSubscription = (await paypalRequest(`billing/subscriptions/${paypalSubscriptionId}`, null, host, 'GET', {
      shouldReportErrors: false,
    })) as unknown as PayPalSubscription;
  } catch (e) {
    const issue = get(e, 'metadata.error.name') || get(e, 'metadata.status');
    logger.warn(`Order #${order.id}: could not fetch PayPal subscription ${paypalSubscriptionId}: ${e.message}`);
    return { paypalOutcome: 'manualReview', error: `${issue ? `${issue}: ` : ''}${e.message}` };
  }

  const paypalStatus = paypalSubscription?.status;
  if (TERMINAL_PAYPAL_STATUSES.includes(paypalStatus)) {
    log(dryRun, `Order #${order.id}: PayPal subscription ${paypalSubscriptionId} is already ${paypalStatus}`);
    return { paypalOutcome: 'alreadyCancelled', paypalStatus };
  } else if (!CANCELLABLE_PAYPAL_STATUSES.includes(paypalStatus)) {
    logger.warn(`Order #${order.id}: unknown PayPal status ${paypalStatus} for subscription ${paypalSubscriptionId}`);
    return { paypalOutcome: 'manualReview', paypalStatus, error: `Unknown PayPal status: ${paypalStatus}` };
  }

  log(dryRun, `Order #${order.id}: cancelling PayPal subscription ${paypalSubscriptionId} (${paypalStatus})`);
  if (!dryRun) {
    try {
      await cancelPaypalSubscription(order, CANCELLATION_REASON, host);
    } catch (e) {
      logger.warn(`Order #${order.id}: could not cancel PayPal subscription ${paypalSubscriptionId}: ${e.message}`);
      return { paypalOutcome: 'manualReview', paypalStatus, error: e.message };
    }
  }

  return { paypalOutcome: 'cancelledOnPaypal', paypalStatus };
};

/**
 * Removes the webhooks pointing to Open Collective, then soft-deletes the PayPal connected account(s) of the host.
 */
const disconnectHost = async (
  host: Collective,
  { dryRun }: { dryRun: boolean },
): Promise<{ deletedWebhookIds: string[]; deletedConnectedAccountIds: number[] }> => {
  const deletedWebhookIds: string[] = [];
  try {
    const webhooks = await listPaypalWebhooks(host);
    for (const webhook of webhooks || []) {
      if (isOpenCollectiveWebhook(webhook)) {
        log(dryRun, `Deleting PayPal webhook ${webhook.id} (${webhook.url})`);
        if (!dryRun) {
          await deletePaypalWebhook(host, webhook.id);
        }
        deletedWebhookIds.push(webhook.id);
      }
    }
  } catch (e) {
    logger.warn(`Could not list/delete the PayPal webhooks of @${host.slug}, delete them manually: ${e.message}`);
  }

  const connectedAccounts = await models.ConnectedAccount.findAll({
    // Only the host's API credentials: "Log in with PayPal" payee accounts have no `clientId` and must be kept
    where: { CollectiveId: host.id, service: 'paypal', clientId: { [Op.ne]: null } },
  });

  for (const connectedAccount of connectedAccounts) {
    log(dryRun, `Deleting PayPal connected account #${connectedAccount.id} (client ID ${connectedAccount.clientId})`);
    if (!dryRun) {
      await connectedAccount.destroy();
    }
  }

  log(
    dryRun,
    `REMINDER: PayPal REST app credentials can't be revoked through the API. Ask @${host.slug} to delete the app (or rotate ` +
      `its secret) on https://developer.paypal.com/dashboard/applications.`,
  );

  return { deletedWebhookIds, deletedConnectedAccountIds: connectedAccounts.map(ca => ca.id) };
};

/**
 * Marks the order as cancelled and its subscription as inactive, without calling PayPal or notifying anyone.
 */
const cancelInDb = async (order: Order, host: Collective, result: OrderResult): Promise<void> => {
  const now = new Date();
  await sequelize.transaction(async transaction => {
    await order.update(
      {
        status: OrderStatuses.CANCELLED,
        data: {
          ...omit(order.data, ASYNC_FLAGS),
          paypalHostDisconnection: {
            HostCollectiveId: host.id,
            at: now.toISOString(),
            reason: CANCELLATION_REASON,
            previousStatus: result.previousStatus,
            paypalOutcome: result.paypalOutcome,
            paypalStatus: result.paypalStatus,
            ...(result.error ? { error: result.error } : null),
          },
        },
      },
      { transaction },
    );

    // Not using `Subscription.deactivate()`, which calls PayPal
    await order.Subscription.update({ isActive: false, deactivatedAt: now, nextChargeDate: null }, { transaction });

    // Record the status change on the timeline (once), without dispatching any notification
    if (result.previousStatus !== OrderStatuses.CANCELLED) {
      await models.Activity.create(
        {
          type: ActivityTypes.SUBSCRIPTION_CANCELED,
          CollectiveId: order.CollectiveId,
          FromCollectiveId: order.FromCollectiveId,
          HostCollectiveId: host.id,
          OrderId: order.id,
          UserId: order.CreatedByUserId,
          data: {
            notify: false,
            subscription: order.Subscription,
            collective: order.collective.minimal,
            fromCollective: order.fromCollective.minimal,
            user: order.createdByUser?.minimal,
            host: host.minimal,
            order: order.info,
            tier: order.Tier?.info,
            previousStatus: result.previousStatus,
            reason: CANCELLATION_REASON,
            reasonCode: 'PAYPAL_HOST_DISCONNECTED',
          },
        },
        { transaction },
      );
    }
  });
};

export const disconnectPaypalHost = async ({
  hostSlug,
  execute = false,
  orderIds = undefined,
  forceDisconnect = false,
  throttleMs = 500,
}: DisconnectHostOptions): Promise<DisconnectHostReport> => {
  const dryRun = !execute;
  const host = await models.Collective.findBySlug(hostSlug, {}, false);
  if (!host) {
    throw new Error(`Host @${hostSlug} not found`);
  }

  const selectedOrderIds = await findOrderIdsWithActivePaypalSubscriptionForHost(host.id, { orderIds });
  if (orderIds) {
    const ignoredOrderIds = orderIds.filter(id => !selectedOrderIds.includes(id));
    if (ignoredOrderIds.length) {
      logger.warn(
        `Ignoring orders without an active PayPal subscription owned by @${host.slug}: ${ignoredOrderIds.join(', ')}`,
      );
    }
  }

  const orders = await loadOrders(selectedOrderIds);
  const isConnected = Boolean(await getHostPaypalAccount(host));
  await printSummary(host, isConnected, orders, dryRun);

  const report: DisconnectHostReport = {
    host: { id: host.id, slug: host.slug },
    dryRun,
    isConnected,
    orders: [],
    cancelledOnPaypal: [],
    alreadyCancelled: [],
    hostNotConnected: [],
    manualReview: [],
    cancelledInDb: [],
    skippedInDb: [],
    disconnectSkipped: false,
    deletedWebhookIds: [],
    deletedConnectedAccountIds: [],
  };

  // 1. Cancel the subscriptions on PayPal
  for (const [index, order] of orders.entries()) {
    const result: OrderResult = {
      orderId: order.id,
      previousStatus: order.status,
      paypalSubscriptionId: order.Subscription.paypalSubscriptionId,
      paypalOutcome: 'hostNotConnected',
    };

    if (isConnected) {
      Object.assign(result, await cancelOnPaypal(order, host, { dryRun }));
      if (throttleMs && index < orders.length - 1) {
        await sleep(throttleMs);
      }
    }

    report.orders.push(result);
    report[result.paypalOutcome].push(order.id);
  }

  // On a connected host, orders that failed on PayPal (possibly transient errors) may still be live there. Keep them
  // (and the PayPal connection) so that a re-run can retry them, unless `forceDisconnect` is set.
  const keepForRetry = isConnected && !forceDisconnect && report.manualReview.length > 0;

  // 2. Cancel in the database. Done before disconnecting the host so that, if it fails, a re-run still sees the
  // connection and records the actual PayPal status.
  for (const [index, order] of orders.entries()) {
    const result = report.orders[index];
    if (keepForRetry && result.paypalOutcome === 'manualReview') {
      logger.warn(`${dryRun ? '[DRY RUN] ' : ''}Order #${order.id}: needs a manual review, leaving it untouched`);
      report.skippedInDb.push(order.id);
      continue;
    }

    log(dryRun, `Order #${order.id}: marking as CANCELLED in the database (was ${order.status})`);
    if (!dryRun) {
      await cancelInDb(order, host, result);
    }
    report.cancelledInDb.push(order.id);
  }

  // 3. Disconnect the host (only when processing all its subscriptions)
  if (isConnected && !orderIds && keepForRetry) {
    report.disconnectSkipped = true;
    logger.warn(
      `${dryRun ? '[DRY RUN] ' : ''}Not disconnecting @${host.slug}: ${report.manualReview.length} orders need a manual review. ` +
        `Fix them on PayPal and re-run, or pass --force-disconnect.`,
    );
  } else if (isConnected && !orderIds) {
    Object.assign(report, await disconnectHost(host, { dryRun }));
  } else if (!isConnected && !orderIds) {
    log(dryRun, `@${host.slug} has no PayPal connection: subscriptions can only be cancelled in our database`);
  }

  // 4. Report
  log(
    dryRun,
    `Done. Cancelled on PayPal: ${report.cancelledOnPaypal.length} ${JSON.stringify(report.cancelledOnPaypal)}`,
  );
  log(
    dryRun,
    `Already cancelled on PayPal: ${report.alreadyCancelled.length} ${JSON.stringify(report.alreadyCancelled)}`,
  );
  if (report.hostNotConnected.length) {
    log(
      dryRun,
      `Not cancelled on PayPal (host not connected): ${report.hostNotConnected.length} ${JSON.stringify(report.hostNotConnected)}`,
    );
  }
  log(dryRun, `Cancelled in DB: ${report.cancelledInDb.length} ${JSON.stringify(report.cancelledInDb)}`);
  if (report.skippedInDb.length) {
    log(dryRun, `Left untouched for a re-run: ${report.skippedInDb.length} ${JSON.stringify(report.skippedInDb)}`);
  }
  if (report.manualReview.length) {
    logger.warn(
      `${dryRun ? '[DRY RUN] ' : ''}Manual review needed on PayPal for ${report.manualReview.length} orders:`,
    );
    for (const result of report.orders.filter(r => r.paypalOutcome === 'manualReview')) {
      logger.warn(`  - Order #${result.orderId} (PayPal subscription ${result.paypalSubscriptionId}): ${result.error}`);
    }
  }

  if (dryRun) {
    logger.info('This was a dry run, run again with --execute to apply the changes.');
  }

  return report;
};

const parseOrderIds = (value: string): number[] => {
  const ids = value.split(',').map(id => id.trim());
  if (!ids.length || ids.some(id => !/^\d+$/.test(id))) {
    throw new Error(`Invalid --orders value: ${value}`);
  }

  return ids.map(id => parseInt(id, 10));
};

const main = async () => {
  const program = new Command();
  program
    .name('disconnect-host')
    .description('Disconnect a host from PayPal and cancel the recurring PayPal contributions it owns')
    .argument('<hostSlug>', 'Slug of the host')
    .option('--execute', 'Apply the changes (dry run by default)')
    .option('--orders <ids>', 'Comma-separated order IDs. Only process these orders and never disconnect the host')
    .option(
      '--force-disconnect',
      'Cancel orders that failed on PayPal in the database and disconnect the host anyway (they may still be live on PayPal)',
    )
    .parse();

  const [hostSlug] = program.args;
  const options = program.opts<{ execute?: boolean; orders?: string; forceDisconnect?: boolean }>();
  try {
    await disconnectPaypalHost({
      hostSlug,
      execute: Boolean(options.execute),
      orderIds: options.orders ? parseOrderIds(options.orders) : undefined,
      forceDisconnect: Boolean(options.forceDisconnect),
    });
  } finally {
    await sequelize.close();
  }
};

if (require.main === module) {
  main().catch(e => {
    logger.error(e);
    process.exit(1);
  });
}
