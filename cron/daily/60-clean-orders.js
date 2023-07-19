#!/usr/bin/env node
import '../../server/env.js';

import { sequelize } from '../../server/models/index.js';

// we have to use raw sql query today
// https://github.com/sequelize/sequelize/issues/3957

Promise.all([
  // Mark all Manual Payments as EXPIRED after 2 months
  // (Until August 2020, it used to be ERROR instead of EXPIRED)
  // Make sure to not include pledges
  sequelize.query(
    `UPDATE "Orders"
  SET "status" = 'EXPIRED', "updatedAt" = NOW()
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
]).then(() => {
  console.log('>>> Clean Orders: done');
  process.exit(0);
});
