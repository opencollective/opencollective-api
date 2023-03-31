import '../../server/env';

import { sequelize } from '../../server/models';

async function run() {
  // Un-save all non-deleted duplicate credit cards, but not the latest
  await sequelize.query(
    `WITH "DuplicatePaymentMethods" AS (
      SELECT COUNT(*), MAX("id") as "latestId", "CollectiveId", "CreatedByUserId", "saved", "data"->'fingerprint'::text as "fingerprint"
      FROM "PaymentMethods"
      WHERE "data"->'fingerprint' IS NOT NULL
      AND "type" = 'creditcard'
      AND "saved" IS TRUE
      AND "deletedAt" IS NULL
      GROUP BY "CollectiveId", "CreatedByUserId", "saved", "data"->'fingerprint'
      HAVING COUNT(*) > 1
    )
    UPDATE "PaymentMethods"
    SET "saved" = FALSE, "updatedAt" = NOW()
    FROM "DuplicatePaymentMethods"
    WHERE "DuplicatePaymentMethods"."fingerprint" = "PaymentMethods"."data"->'fingerprint'::text
    AND "PaymentMethods"."id" != "DuplicatePaymentMethods"."latestId"
    AND "PaymentMethods"."CollectiveId" = "DuplicatePaymentMethods"."CollectiveId"
    AND "PaymentMethods"."CreatedByUserId" = "DuplicatePaymentMethods"."CreatedByUserId"
    AND "PaymentMethods"."deletedAt" IS NULL
    AND "PaymentMethods"."saved" IS TRUE`,
  );

  // Update all orders with duplicate payment methods to use the latest one
  await sequelize.query(
    `WITH "DuplicatePaymentMethods" AS (
      SELECT COUNT(DISTINCT pm."id"), MAX(pm."id") as "latestId", pm."CollectiveId", pm."CreatedByUserId", pm."data"->'fingerprint'::text as "fingerprint"
      FROM "PaymentMethods" pm, "Orders" o
      WHERE pm."data"->'fingerprint' IS NOT NULL
      AND pm."type" = 'creditcard'
      AND pm."deletedAt" IS NULL
      AND o."PaymentMethodId" = pm."id"
      AND o."deletedAt" IS NULL
      AND o."status" = 'ACTIVE'
      GROUP BY pm."CollectiveId", pm."CreatedByUserId", pm."data"->'fingerprint'
      HAVING COUNT(DISTINCT pm."id") > 1
    )
    UPDATE "Orders"
    SET "PaymentMethodId" = dpm."latestId"
    FROM "PaymentMethods" pm, "DuplicatePaymentMethods" dpm
    WHERE dpm."fingerprint" = pm."data"->'fingerprint'::text
    AND pm.id != dpm."latestId"
    AND pm."CollectiveId" = dpm."CollectiveId"
    AND pm."CreatedByUserId" = dpm."CreatedByUserId"
    AND pm."deletedAt" IS NULL
    AND "Orders"."PaymentMethodId" = pm."id"
    AND "Orders"."status" = 'ACTIVE'`,
  );
}

run()
  .then(() => {
    console.log('>>> Completed!');
    process.exit();
  })
  .catch(err => {
    console.error(err);
    process.exit();
  });
