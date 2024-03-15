/**
 * A script to cancel all recurring contributions for OCF.
 */

import '../server/env';

import { QueryTypes } from 'sequelize';

import FEATURE from '../server/constants/feature';
import OrderStatuses from '../server/constants/order-status';
import { defaultHostCollective } from '../server/lib/utils';
import { Collective, sequelize } from '../server/models';

export const main = async ({ overrideDryRun = false } = {}) => {
  if (process.env.DRY_RUN !== 'false' && !overrideDryRun) {
    console.error('DRY_RUN is not set to false, exiting');
    return;
  }

  // Disable contributions
  const ocf = await Collective.findByPk(defaultHostCollective('foundation').CollectiveId);
  await ocf.update({
    data: {
      ...ocf.data,
      features: {
        ...ocf.data?.features,
        [FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS]: false,
      },
    },
  });

  // Cancel all existing contributions
  // The query below is a copy-paste from `Orders.stopActiveSubscriptions`, adapted to run on the entire Host
  await sequelize.query(
    `
      UPDATE "Orders"
      SET
        status = :newStatus,
        "updatedAt" = NOW(),
        "data" = COALESCE("data", '{}'::JSONB) || JSONB_BUILD_OBJECT(
          'needsAsyncDeactivation', TRUE,
          'isOCFShutdown', TRUE,
          'messageSource', 'PLATFORM'
        )
      WHERE id IN (
        SELECT "Orders".id FROM "Orders"
        INNER JOIN "Subscriptions" ON "Subscriptions".id = "Orders"."SubscriptionId"
        INNER JOIN "Collectives" c ON c.id = "Orders"."CollectiveId"
        WHERE c."HostCollectiveId" = :hostCollectiveId
        AND c."approvedAt" IS NOT NULL
        AND "Subscriptions"."isActive" IS TRUE
        AND "Orders"."status" != :newStatus
        AND "Orders"."deletedAt" IS NULL
        AND "Subscriptions"."deletedAt" IS NULL
      )
    `,
    {
      type: QueryTypes.UPDATE,
      raw: true,
      replacements: {
        hostCollectiveId: ocf.id,
        newStatus: OrderStatuses.PAUSED,
        messageSource: 'PLATFORM',
      },
    },
  );

  // And that's it, the actual cancellations and sending of emails will be handled asynchronously by
  // the `cron/hourly/70-handle-batch-subscriptions-update.ts` CRON job.
};

if (require.main === module) {
  main()
    .then(() => process.exit())
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
