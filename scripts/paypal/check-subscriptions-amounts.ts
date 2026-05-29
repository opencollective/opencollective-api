/**
 * Compares Orders.totalAmount to the PaypalPlans row for each PayPal subscription's live plan_id
 * (same invariant as verifySubscription in setupPaypalSubscriptionForOrder).
 *
 * Default scope: active PayPal-managed subscriptions whose Subscriptions.updatedAt is within the last 7 days
 * (to limit PayPal API calls). Override with --days.
 *
 * Usage:
 *   npm run script scripts/paypal/check-subscriptions-amounts.ts
 *   npm run script scripts/paypal/check-subscriptions-amounts.ts -- --days 30
 */

import '../../server/env';

import { Command } from 'commander';
import moment from 'moment';
import { QueryTypes } from 'sequelize';

import OrderStatuses from '../../server/constants/order-status';
import logger from '../../server/lib/logger';
import { sleep } from '../../server/lib/utils';
import models, { sequelize } from '../../server/models';
import { fetchPaypalSubscription } from '../../server/paymentProviders/paypal/subscription';

/**
 * @returns list of mismatch / error lines (empty if OK)
 */
async function checkPaypalSubscriptionAmountsAgainstDb(days: number): Promise<string[]> {
  const since = moment().subtract(days, 'days').toDate();

  const rows = await sequelize.query<{ orderId: number; subscriptionId: number; paypalSubscriptionId: string }>(
    `
    SELECT o."id" AS "orderId", s."id" AS "subscriptionId", s."paypalSubscriptionId" AS "paypalSubscriptionId"
    FROM "Orders" o
    INNER JOIN "Subscriptions" s ON s."id" = o."SubscriptionId"
    INNER JOIN "PaymentMethods" pm ON pm."id" = o."PaymentMethodId"
    WHERE o."deletedAt" IS NULL
      AND o."status" = :activeStatus
      AND s."deletedAt" IS NULL
      AND s."isActive" = true
      AND s."isManagedExternally" = true
      AND s."paypalSubscriptionId" IS NOT NULL
      AND pm."service" = 'paypal'
      AND pm."type" = 'subscription'
      AND s."updatedAt" >= :since
    `,
    {
      replacements: { since, activeStatus: OrderStatuses.ACTIVE },
      type: QueryTypes.SELECT,
      raw: true,
    },
  );

  if (!rows.length) {
    return [];
  }

  const mismatches: string[] = [];

  for (const row of rows) {
    try {
      const order = await models.Order.findByPk(row.orderId, {
        include: [
          { association: 'collective', required: true },
          { model: models.Subscription, required: true },
        ],
      });

      if (!order?.collective) {
        continue;
      }

      const host = await order.collective.getHostCollective();
      if (!host) {
        mismatches.push(`Order #${order.id}: no host for collective`);
        continue;
      }

      const paypalSub = await fetchPaypalSubscription(host, row.paypalSubscriptionId);
      const planId = paypalSub.plan_id;
      if (!planId) {
        mismatches.push(`Order #${order.id}: PayPal subscription ${row.paypalSubscriptionId} has no plan_id`);
        continue;
      }

      const plan = await models.PaypalPlan.findByPk(planId);
      if (!plan) {
        mismatches.push(`Order #${order.id}: PayPal plan ${planId} not found in PaypalPlans`);
        continue;
      }

      if (plan.amount !== order.totalAmount) {
        mismatches.push(
          `Order #${order.id} (Subscription #${row.subscriptionId}): order totalAmount ${order.totalAmount} !== PaypalPlan ${planId} amount ${plan.amount}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`PayPal amount check: order ${row.orderId}: ${message}`);
      mismatches.push(`Order #${row.orderId}: ${message}`);
    }

    await sleep(500);
  }

  return mismatches;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('check-subscriptions-amounts')
    .allowExcessArguments(true)
    .description(
      'Verify Order.totalAmount matches PaypalPlans for active PayPal subscriptions (Subscriptions.updatedAt within lookback window)',
    )
    .option('--days <n>', 'Only consider subscriptions updated in the last N days (default: 7)')
    .parse();

  const opts = program.opts<{ days?: string }>();
  const days = (opts.days && parseInt(opts.days, 10)) ?? 7;
  try {
    const mismatches = await checkPaypalSubscriptionAmountsAgainstDb(days);

    if (mismatches.length > 0) {
      logger.error(
        `PayPal subscription amount vs Order (${days}d lookback on Subscriptions.updatedAt):\n${mismatches.join('\n')}`,
      );
      process.exitCode = 1;
    } else {
      logger.info(`check-subscriptions-amounts: OK (${days}d lookback on Subscriptions.updatedAt, no mismatches).`);
    }
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  main().catch(e => {
    logger.error(e);
    process.exit(1);
  });
}
