import '../../server/env';

import { sequelize } from '../../server/models';

import { runCheckThenExit } from './_utils';

async function checkDuplicateNonRecurringContribution() {
  const message = 'Duplicate non-recurring Contribution (no auto fix)';

  const results = await sequelize.query(
    `SELECT COUNT(*), o."id"
     FROM "Transactions" t
     INNER JOIN "Orders" o ON o."id" = t."OrderId"
     WHERE t."deletedAt" IS NULL
     AND t."createdAt" > '2024-01-01'
     AND t."OrderId" IS NOT NULL
     AND t."kind" = 'CONTRIBUTION'
     AND t."type" = 'CREDIT'
     AND t."RefundTransactionId" IS NULL
     AND o."SubscriptionId" IS NULL
     GROUP BY o."id"
     HAVING COUNT(*) > 1`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    // Not fixable
    throw new Error(message);
  }
}

async function checkPaidOrdersWithNullProcessedAt({ fix = false } = {}) {
  const message = 'Paid Order with null processedAt';

  const results = await sequelize.query(`
    SELECT id, "updatedAt"
    FROM "Orders"
    WHERE status = 'PAID'
    AND "processedAt" IS NULL
    ORDER BY "createdAt" DESC
  `);

  if (results.length > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      await sequelize.query(`
        UPDATE "Orders"
        SET "processedAt" = "updatedAt"
        WHERE status = 'PAID'
        AND "processedAt" IS NULL
      `);
    }
  }
}

export async function checkOrders({ fix = false } = {}) {
  await checkDuplicateNonRecurringContribution();
  await checkPaidOrdersWithNullProcessedAt({ fix });
}

if (!module.parent) {
  runCheckThenExit(checkOrders);
}
