/**
 * Seeds custom_id on all existing PayPal subscriptions so our order reference
 * appears on the PayPal dashboard. Run once to backfill subscriptions created
 * before we started setting custom_id in setupPaypalSubscriptionForOrder.
 *
 * Usage:
 *   npx ts-node scripts/paypal/seed-subscriptions-custom-id.ts
 *   npx ts-node scripts/paypal/seed-subscriptions-custom-id.ts --dry-run
 *   npx ts-node scripts/paypal/seed-subscriptions-custom-id.ts --limit 10
 *   npx ts-node scripts/paypal/seed-subscriptions-custom-id.ts --hosts host1,host2
 *   npx ts-node scripts/paypal/seed-subscriptions-custom-id.ts --order-ids 123,456,789
 */

import '../../server/env';

import { Command } from 'commander';
import { Op } from 'sequelize';

import logger from '../../server/lib/logger';
import models from '../../server/models';
import { setPaypalSubscriptionOrderId } from '../../server/paymentProviders/paypal/subscription';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const parseList = (value: string | undefined, asNumbers = false): (string | number)[] | undefined => {
  if (value === undefined || value === '') {
    return undefined;
  }
  const items = value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (items.length === 0) {
    return undefined;
  }
  return asNumbers ? items.map(s => parseInt(s, 10)).filter(n => !Number.isNaN(n)) : items;
};

const main = async (): Promise<void> => {
  const program = new Command();
  program
    .option('--dry-run', 'Only log what would be updated, do not call PayPal')
    .option('--limit <n>', 'Max number of subscriptions to update (default: all)', parseInt)
    .option('--hosts <slugs>', 'Comma-separated list of host slugs to restrict to')
    .option('--order-ids <ids>', 'Comma-separated list of order IDs to restrict to')
    .parse();

  const options = program.opts();
  const dryRun = Boolean(options.dryRun);
  const limit = options.limit as number | undefined;
  const hostSlugs = parseList(options.hosts) as string[] | undefined;
  const orderIds = parseList(options.orderIds, true) as number[] | undefined;

  const orderWhere: Record<string, unknown> = {
    SubscriptionId: { [Op.ne]: null },
  };
  if (orderIds?.length) {
    orderWhere.id = { [Op.in]: orderIds };
  }

  let hostIds: number[] | undefined;
  if (hostSlugs?.length) {
    logger.warn(
      'You have specified --hosts, be aware that this will only affect contributions for currently hosted collectives.',
    );
    const hostCollectives = await models.Collective.findAll({
      where: { slug: { [Op.in]: hostSlugs } },
      attributes: ['id'],
    });
    hostIds = hostCollectives.map(c => c.id);
    if (hostIds.length === 0) {
      logger.error(`No hosts found for slugs: ${hostSlugs.join(', ')}`);
      process.exit(1);
    }
    logger.info(`Restricting to hosts: ${hostSlugs.join(', ')} (ids: ${hostIds.join(', ')})`);
  }

  const collectiveInclude: Record<string, unknown> = { model: models.Collective, as: 'collective' };
  if (hostIds?.length) {
    collectiveInclude.where = { HostCollectiveId: { [Op.in]: hostIds } };
    collectiveInclude.required = true;
  }

  const orders = await models.Order.findAll({
    where: orderWhere,
    include: [
      {
        model: models.Subscription,
        required: true,
        where: {
          paypalSubscriptionId: { [Op.ne]: null },
        },
      },
      collectiveInclude,
    ],
    order: [['id', 'ASC']],
    ...(limit ? { limit } : {}),
  });

  const filterDesc = [
    orderIds?.length ? `order IDs ${orderIds.join(', ')}` : null,
    hostSlugs?.length ? `hosts ${hostSlugs.join(', ')}` : null,
    limit ? `limit ${limit}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  logger.info(
    `Found ${orders.length} order(s) with PayPal subscriptions${filterDesc ? ` (${filterDesc})` : ''}. Dry run: ${dryRun}`,
  );

  let updated = 0;
  let failed = 0;

  for (const order of orders) {
    const paypalSubscriptionId = order.Subscription.paypalSubscriptionId;

    try {
      const host = await order.collective.getHostCollective();
      if (!host) {
        logger.warn(`Order #${order.id}: collective has no host, skipping`);
        failed++;
        continue;
      }

      if (dryRun) {
        logger.info(
          `[dry-run] Would set custom_id on PayPal subscription ${paypalSubscriptionId} (Order #${order.id})`,
        );
        updated++;
        continue;
      }

      await setPaypalSubscriptionOrderId(host, paypalSubscriptionId, order);
      updated++;
      logger.info(`Set custom_id on subscription ${paypalSubscriptionId} (Order #${order.id})`);
    } catch (e) {
      failed++;
      logger.warn(`Failed to set custom_id on subscription ${paypalSubscriptionId} (Order #${order.id}): ${e.message}`);
    }

    await sleep(100); // Avoid rate limiting
  }

  logger.info(`Done. Updated: ${updated}, Failed: ${failed}`);
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(e => {
      logger.error(e);
      process.exit(1);
    });
}
