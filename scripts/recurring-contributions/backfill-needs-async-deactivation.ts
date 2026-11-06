/**
 * Backfill for https://github.com/opencollective/opencollective/issues/8915 and
 * https://github.com/opencollective/opencollective/issues/7701.
 *
 * Before those were fixed, bulk cancellations (`deleteTier(stopRecurringContributions: true)`, archiving an
 * account) marked orders `CANCELLED` without deactivating their `Subscription`. The recurring-charge cron kept
 * matching those orders and, on a successful charge, flipped them back to `ACTIVE` - so the contributions kept
 * being charged, in some cases for months.
 *
 * This script finds two kinds of affected orders:
 * - `CANCELLED` orders whose subscription is still active (not charged again yet, or managed externally);
 * - orders that were charged again and flipped back to `ACTIVE`/`ERROR`: made by an archived account, or made to a
 *   deleted tier while their history shows they were cancelled. These contributors were charged after their
 *   cancellation: the script lists them so that refunds can be reviewed.
 *
 * It moves them to `CANCELLED`, flags them for asynchronous deactivation (`data.needsAsyncDeactivation`) and
 * bumps `updatedAt` (the `handle-batch-subscriptions-update` job only looks one month back), so the existing
 * 10-minute job can drain them: it deactivates the subscription and calls the payment provider for externally
 * managed subscriptions (PayPal).
 *
 * The drain is silent: `createStatusChangeActivity: false` makes the job record the `SUBSCRIPTION_CANCELED`
 * activity with `data.notify: false`, so nothing is dispatched to the contributor. These cancellations happened a
 * long time ago; surprising people with an email now would be worse than a quiet timeline entry.
 *
 * Dry-run by default: pass `--execute` to actually write.
 */

import '../../server/env';

import { Command } from 'commander';
import { QueryTypes } from 'sequelize';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

type BackfillOptions = {
  isDryRun: boolean;
  limit?: number;
  orderIds?: number[];
  collectiveSlug?: string;
};

type OrderToFlagReason = 'CANCELLED_WITH_ACTIVE_SUBSCRIPTION' | 'CHARGED_AFTER_ARCHIVE' | 'CHARGED_AFTER_TIER_DELETION';

type OrderToFlag = {
  id: number;
  status: string;
  reason: OrderToFlagReason;
  collectiveId: number;
  fromCollectiveId: number;
  updatedAt: Date;
  isManagedExternally: boolean;
  collectiveSlug: string;
  fromCollectiveSlug: string;
};

export const findOrdersToFlag = async ({
  limit = undefined,
  orderIds = undefined,
  collectiveSlug = undefined,
}: Omit<BackfillOptions, 'isDryRun'> = {}): Promise<OrderToFlag[]> => {
  const replacements: Record<string, unknown> = { limit: limit ?? null };
  const filters: string[] = [];

  if (collectiveSlug) {
    filters.push(`AND to_collective.slug = :collectiveSlug`);
    replacements.collectiveSlug = collectiveSlug;
  }

  if (orderIds?.length) {
    filters.push(`AND "Orders".id IN (:orderIds)`);
    replacements.orderIds = orderIds;
  }

  return sequelize.query<OrderToFlag>(
    `
      SELECT
        "Orders".id AS id,
        "Orders".status AS status,
        CASE
          WHEN "Orders".status = 'CANCELLED' THEN 'CANCELLED_WITH_ACTIVE_SUBSCRIPTION'
          WHEN from_collective."deactivatedAt" IS NOT NULL THEN 'CHARGED_AFTER_ARCHIVE'
          ELSE 'CHARGED_AFTER_TIER_DELETION'
        END AS reason,
        "Orders"."CollectiveId" AS "collectiveId",
        "Orders"."FromCollectiveId" AS "fromCollectiveId",
        "Orders"."updatedAt" AS "updatedAt",
        "Subscriptions"."isManagedExternally" AS "isManagedExternally",
        to_collective.slug AS "collectiveSlug",
        from_collective.slug AS "fromCollectiveSlug"
      FROM "Orders"
      INNER JOIN "Subscriptions" ON "Subscriptions".id = "Orders"."SubscriptionId"
      INNER JOIN "Collectives" to_collective ON to_collective.id = "Orders"."CollectiveId"
      INNER JOIN "Collectives" from_collective ON from_collective.id = "Orders"."FromCollectiveId"
      LEFT JOIN "Tiers" tier ON tier.id = "Orders"."TierId"
      WHERE (
          "Orders"."status" = 'CANCELLED'
          OR (
            -- Charged again after the bulk cancellation, which flipped them back to ACTIVE (or ERROR on a failed retry)
            "Orders"."status" IN ('ACTIVE', 'ERROR')
            AND (
              from_collective."deactivatedAt" IS NOT NULL
              OR (
                tier."deletedAt" IS NOT NULL
                -- Deleting a tier without stopRecurringContributions legitimately keeps its contributions active
                AND EXISTS (
                  SELECT 1 FROM "OrderHistories" h WHERE h.id = "Orders".id AND h.status = 'CANCELLED'
                )
              )
            )
          )
        )
        AND "Orders"."deletedAt" IS NULL
        AND "Subscriptions"."deletedAt" IS NULL
        AND "Subscriptions"."isActive" IS TRUE
        AND COALESCE(("Orders"."data" ->> 'needsAsyncDeactivation')::BOOLEAN, FALSE) IS NOT TRUE
        ${filters.join('\n        ')}
      ORDER BY "Orders".id
      LIMIT :limit
    `,
    {
      type: QueryTypes.SELECT,
      replacements,
    },
  );
};

export const flagOrdersForAsyncDeactivation = async (orderIds: number[]): Promise<void> => {
  if (!orderIds.length) {
    return;
  }

  await sequelize.query(
    `
      UPDATE "Orders"
      SET
        status = 'CANCELLED',
        "updatedAt" = NOW(),
        "data" = COALESCE("data", '{}'::JSONB) || JSONB_BUILD_OBJECT(
          'needsAsyncDeactivation', TRUE,
          'createStatusChangeActivity', FALSE
        )
      WHERE "Orders".id IN (:orderIds)
    `,
    { type: QueryTypes.UPDATE, replacements: { orderIds } },
  );
};

const run = async ({ isDryRun, limit, orderIds, collectiveSlug }: BackfillOptions): Promise<void> => {
  const orders = await findOrdersToFlag({ limit, orderIds, collectiveSlug });

  if (!orders.length) {
    logger.info('No cancelled recurring contribution with an active subscription found. Nothing to do.');
    return;
  }

  const externallyManagedCount = orders.filter(order => order.isManagedExternally).length;
  logger.info(
    `Found ${orders.length} cancelled recurring contribution(s) still having an active subscription` +
      ` (${externallyManagedCount} managed by an external provider):`,
  );

  for (const order of orders) {
    logger.info(
      `  - Order #${order.id} (${order.status}, ${order.reason}) from @${order.fromCollectiveSlug}` +
        ` to @${order.collectiveSlug} (last updated ${order.updatedAt.toISOString()}, ` +
        `${order.isManagedExternally ? 'external' : 'internal'} subscription)`,
    );
  }

  const chargedAfterCancellation = orders.filter(order => order.reason !== 'CANCELLED_WITH_ACTIVE_SUBSCRIPTION');
  if (chargedAfterCancellation.length) {
    logger.warn(
      `${chargedAfterCancellation.length} order(s) were charged after their cancellation and will be moved back to` +
        ` CANCELLED. Review them for refunds: ${chargedAfterCancellation.map(order => order.id).join(', ')}`,
    );
  }

  if (isDryRun) {
    logger.info('Dry run mode enabled, exiting without making changes. Pass --execute to apply.');
    return;
  }

  await flagOrdersForAsyncDeactivation(orders.map(order => order.id));
  logger.info(
    `Flagged ${orders.length} order(s) for asynchronous deactivation. The 10-minute ` +
      '`handle-batch-subscriptions-update` job will deactivate their subscriptions and call the payment ' +
      'providers. Nothing is sent to the contributors.',
  );
};

const main = async (): Promise<void> => {
  const program = new Command();
  program.showSuggestionAfterError();
  program.description(
    'Flag cancelled recurring contributions that still have an active subscription for asynchronous deactivation',
  );
  program.option('--execute', 'Actually write the changes (dry-run by default)', false);
  program.option('--limit <n>', 'Only process the N first orders', value => parseInt(value));
  program.option('--order-ids <ids>', 'Comma-separated list of order ids to process', value =>
    value.split(',').map(id => parseInt(id.trim())),
  );
  program.option('--collective <slug>', 'Only process the contributions received by this collective');
  program.parse();

  const options = program.opts();
  await run({
    isDryRun: !options.execute,
    limit: options.limit,
    orderIds: options.orderIds,
    collectiveSlug: options.collective,
  });
};

if (require.main === module) {
  main()
    .then(() => process.exit())
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
