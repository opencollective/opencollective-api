/**
 * Disables `auto_bill_outstanding` on all existing PayPal plans and subscriptions. When enabled, PayPal bills
 * the outstanding balance (missed cycles) together with the next successful cycle, which surprises contributors
 * (e.g. a $150/month contribution charged $600) and leads to cancellations and disputes.
 * See https://github.com/opencollective/opencollective/issues/6600.
 *
 * - Plans: new plans are created with `auto_bill_outstanding: false`, but existing ones are re-used by
 *   `getOrCreatePlan`, so we patch them for future subscriptions.
 * - Subscriptions: we override the plan setting on each ACTIVE/SUSPENDED subscription, since PayPal doesn't
 *   document whether plan updates apply to existing subscriptions.
 *
 * This doesn't reset outstanding balances: they stay on PayPal but won't be billed automatically anymore.
 *
 * Usage:
 *   npm run script scripts/paypal/disable-auto-bill-outstanding.ts -- --dry-run
 *   npm run script scripts/paypal/disable-auto-bill-outstanding.ts -- --hosts host1,host2
 *   npm run script scripts/paypal/disable-auto-bill-outstanding.ts -- --skip-plans
 *   npm run script scripts/paypal/disable-auto-bill-outstanding.ts -- --skip-subscriptions
 */

import '../../server/env';

import { Command } from 'commander';
import { Op } from 'sequelize';

import OrderStatuses from '../../server/constants/order-status';
import logger from '../../server/lib/logger';
import { sleep } from '../../server/lib/utils';
import models, { Collective, sequelize } from '../../server/models';
import { paypalRequest } from '../../server/paymentProviders/paypal/api';
import { fetchPaypalSubscription } from '../../server/paymentProviders/paypal/subscription';

// Orders that may still have a live (ACTIVE or SUSPENDED) subscription on PayPal
const ORDER_STATUSES = [OrderStatuses.ACTIVE, OrderStatuses.PAUSED, OrderStatuses.ERROR, OrderStatuses.PROCESSING];
const PATCHABLE_SUBSCRIPTION_STATUSES = ['ACTIVE', 'SUSPENDED'];

type Options = { dryRun: boolean; hostIds?: number[] };

const getHostIdsFromSlugs = async (slugs: string[]): Promise<number[]> => {
  const hosts = await models.Collective.findAll({ where: { slug: { [Op.in]: slugs } }, attributes: ['id'] });
  if (hosts.length !== slugs.length) {
    throw new Error(`Some hosts were not found: ${slugs.join(', ')}`);
  }

  return hosts.map(host => host.id);
};

const disableOnPlans = async ({ dryRun, hostIds }: Options): Promise<void> => {
  const plans = await models.PaypalPlan.findAll({
    order: [['createdAt', 'ASC']],
    include: [
      {
        association: 'product',
        required: true,
        where: hostIds ? { HostCollectiveId: { [Op.in]: hostIds } } : undefined,
      },
    ],
  });

  logger.info(`Found ${plans.length} PayPal plan(s)`);
  const hostsCache = new Map<number, Collective>();
  let updated = 0;
  let failed = 0;
  for (const plan of plans) {
    const hostId = plan['product'].HostCollectiveId;
    try {
      if (!hostsCache.has(hostId)) {
        hostsCache.set(hostId, await models.Collective.findByPk(hostId));
      }

      if (dryRun) {
        logger.info(`[dry-run] Would disable auto_bill_outstanding on plan ${plan.id} (host #${hostId})`);
      } else {
        await paypalRequest(
          `billing/plans/${plan.id}`,
          [{ op: 'replace', path: '/payment_preferences/auto_bill_outstanding', value: false }],
          hostsCache.get(hostId),
          'PATCH',
          { shouldReportErrors: false },
        );
        await sleep(100); // Avoid rate limiting
      }
      updated++;
    } catch (e) {
      failed++;
      logger.warn(`Failed to update plan ${plan.id} (host #${hostId}): ${e.message}`);
    }
  }

  logger.info(`Plans done. Updated: ${updated}, Failed: ${failed}`);
};

const disableOnSubscriptions = async ({ dryRun, hostIds }: Options): Promise<void> => {
  const orders = await models.Order.findAll({
    order: [['id', 'ASC']],
    where: { status: { [Op.in]: ORDER_STATUSES } },
    include: [
      {
        model: models.Subscription,
        required: true,
        where: { paypalSubscriptionId: { [Op.ne]: null }, isManagedExternally: true },
      },
      {
        association: 'collective',
        required: true,
        where: hostIds ? { HostCollectiveId: { [Op.in]: hostIds } } : undefined,
      },
    ],
  });

  logger.info(`Found ${orders.length} order(s) with a PayPal subscription`);
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  for (const order of orders) {
    const paypalSubscriptionId = order.Subscription.paypalSubscriptionId;
    try {
      const host = await order.collective.getHostCollective();
      if (!host) {
        logger.warn(`Order #${order.id}: collective has no host, skipping`);
        skipped++;
        continue;
      }

      const paypalSubscription = await fetchPaypalSubscription(host, paypalSubscriptionId);
      if (!PATCHABLE_SUBSCRIPTION_STATUSES.includes(paypalSubscription.status)) {
        logger.info(
          `Order #${order.id}: subscription ${paypalSubscriptionId} is ${paypalSubscription.status}, skipping`,
        );
        skipped++;
        continue;
      }

      const outstandingBalance = paypalSubscription.billing_info?.outstanding_balance;
      if (outstandingBalance && Number(outstandingBalance.value) > 0) {
        logger.info(
          `Order #${order.id}: subscription ${paypalSubscriptionId} has an outstanding balance of ${outstandingBalance.value} ${outstandingBalance.currency_code}`,
        );
      }

      if (dryRun) {
        logger.info(
          `[dry-run] Would disable auto_bill_outstanding on subscription ${paypalSubscriptionId} (Order #${order.id})`,
        );
      } else {
        await paypalRequest(
          `billing/subscriptions/${paypalSubscriptionId}`,
          [{ op: 'replace', path: '/plan/payment_preferences/auto_bill_outstanding', value: false }],
          host,
          'PATCH',
          { shouldReportErrors: false },
        );
      }
      updated++;
    } catch (e) {
      failed++;
      logger.warn(`Failed to update subscription ${paypalSubscriptionId} (Order #${order.id}): ${e.message}`);
    }

    await sleep(100); // Avoid rate limiting
  }

  logger.info(`Subscriptions done. Updated: ${updated}, Skipped: ${skipped}, Failed: ${failed}`);
};

const main = async (): Promise<void> => {
  const program = new Command();
  program
    .option('--dry-run', 'Only log what would be updated, do not update PayPal')
    .option('--hosts <slugs>', 'Comma-separated list of host slugs to restrict to')
    .option('--skip-plans', 'Do not update plans')
    .option('--skip-subscriptions', 'Do not update subscriptions')
    .parse();

  const options = program.opts();
  const hostSlugs = options.hosts?.split(',').map(slug => slug.trim());
  const params: Options = {
    dryRun: Boolean(options.dryRun),
    hostIds: hostSlugs?.length ? await getHostIdsFromSlugs(hostSlugs) : undefined,
  };

  if (!options.skipPlans) {
    await disableOnPlans(params);
  }
  if (!options.skipSubscriptions) {
    await disableOnSubscriptions(params);
  }
};

if (require.main === module) {
  main()
    .then(() => sequelize.close())
    .then(() => process.exit(0))
    .catch(e => {
      logger.error(e);
      process.exit(1);
    });
}
