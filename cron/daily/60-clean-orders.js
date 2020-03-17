#!/usr/bin/env node
import '../../server/env';

import { sequelize } from '../../server/models';

// we have to use raw sql query today
// https://github.com/sequelize/sequelize/issues/3957

Promise.all([
  // Mark all Manual Payments as ERROR after 2 months
  // Make sure to not include pledges
  sequelize.query(
    `UPDATE "Orders"
  SET "status" = 'ERROR', "updatedAt" = NOW()
  FROM "Collectives"
  WHERE "Orders"."status" = 'PENDING'
  AND "Orders"."PaymentMethodId" IS NULL
  AND "Collectives"."id" = "Orders"."CollectiveId"
  AND "Collectives"."isPledged" = FALSE
  AND "Collectives"."HostCollectiveId" IS NOT NULL
  AND "Orders"."createdAt" <  (NOW() - interval '2 month')
  AND (
    -- Either the collective is not a previously pledged collective
    ("Collectives"."data" ->> 'hasBeenPledged')::boolean IS NOT TRUE
    -- Or the order was created before the activation (which means it was a pledge)
    OR "Orders"."createdAt" < "Collectives"."approvedAt"
  )`,
  ),

  // Mark all PENDING errors that are not Manual Payments or Pledge as ERROR after 1 day
  // No need to check for Orders made to previously pledged collectives here because pledged orders
  // always have a null `PaymentMethodId`.
  sequelize.query(
    `UPDATE "Orders"
  SET "status" = 'ERROR', "updatedAt" = NOW()
  FROM "Collectives"
  WHERE "Orders"."status" = 'PENDING'
  AND "Orders"."PaymentMethodId" IS NOT NULL
  AND "Collectives"."id" = "Orders"."CollectiveId"
  AND "Collectives"."isPledged" = FALSE
  AND "Collectives"."HostCollectiveId" IS NOT NULL
  AND "Orders"."createdAt" <  (NOW() - interval '1 day')`,
  ),
]).then(() => {
  console.log('>>> Clean Orders: done');
  process.exit(0);
});
