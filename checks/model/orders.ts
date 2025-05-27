import '../../server/env';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

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

  const results = await sequelize.query(
    `
    SELECT id, "updatedAt"
    FROM "Orders"
    WHERE status = 'PAID'
    AND "processedAt" IS NULL
    ORDER BY "createdAt" DESC
  `,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(`
        UPDATE "Orders"
        SET "processedAt" = "updatedAt"
        WHERE status = 'PAID'
        AND "processedAt" IS NULL
      `);
    }
  }
}

async function checkPaidOrdersWithDeletedTransactions({ fix = false } = {}) {
  const message = 'Paid Orders with deleted transactions';

  const results = await sequelize.query(
    `
    SELECT *
    FROM "Orders"
    WHERE "deletedAt" IS NULL
    AND "status" = 'PAID'
    AND EXISTS (
      SELECT * FROM "Transactions" WHERE "OrderId" = "Orders"."id" AND "deletedAt" IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT * FROM "Transactions" WHERE "OrderId" = "Orders"."id" AND "deletedAt" IS NULL
    )
    `,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(`
        UPDATE "Orders"
        SET "deletedAt" = NOW()
        WHERE "deletedAt" IS NULL
        AND "status" = 'PAID'
        AND EXISTS (
          SELECT * FROM "Transactions" WHERE "OrderId" = "Orders"."id" AND "deletedAt" IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT * FROM "Transactions" WHERE "OrderId" = "Orders"."id" AND "deletedAt" IS NULL
        )
      `);
    }
  }
}

async function checkOrdersCollectiveIdMismatch({ fix = false } = {}) {
  const message = 'Paid Orders with CollectiveId/FromCollectiveId mimsatch in Transactions';

  const results = await sequelize.query(
    `
    SELECT *
    FROM "Orders"
    INNER JOIN "Transactions" ON "OrderId" = "Orders"."id" AND "Transactions"."deletedAt" IS NULL
    AND "Transactions"."kind" IN ('CONTRIBUTION', 'ADDED_FUNDS') AND "Transactions"."type" = 'CREDIT'
    AND "Transactions"."RefundTransactionId" IS NULL
    WHERE "Orders"."deletedAt" IS NULL
    AND "Orders"."status" = 'PAID'
    AND NOT EXISTS (
      SELECT *
      FROM "Transactions" t
      WHERE "OrderId" = "Orders"."id"
      AND "Orders"."CollectiveId" = t."CollectiveId"
      AND "Orders"."FromCollectiveId" = t."FromCollectiveId"
      AND t."deletedAt" IS NULL
    )
    AND "Orders"."createdAt" > '2017-01-01'
    `,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(`
      UPDATE "Orders"
      SET "FromCollectiveId" = "Transactions"."FromCollectiveId", "CollectiveId" = "Transactions"."CollectiveId"
      FROM "Transactions"
      WHERE "Orders"."deletedAt" IS NULL
      AND "Orders"."status" = 'PAID'
      AND NOT EXISTS (
        SELECT *
        FROM "Transactions" t
        WHERE "OrderId" = "Orders"."id"
        AND "Orders"."CollectiveId" = t."CollectiveId"
        AND "Orders"."FromCollectiveId" = t."FromCollectiveId"
        AND t."deletedAt" IS NULL
      )
      AND "Orders"."createdAt" > '2017-01-01'
      AND "OrderId" = "Orders"."id" AND "Transactions"."deletedAt" IS NULL
      AND "Transactions"."kind" IN ('CONTRIBUTION', 'ADDED_FUNDS') AND "Transactions"."type" = 'CREDIT'
      AND "Transactions"."RefundTransactionId" IS NULL
      `);
    }
  }
}

export const checks = [
  checkDuplicateNonRecurringContribution,
  checkPaidOrdersWithNullProcessedAt,
  checkPaidOrdersWithDeletedTransactions,
  checkOrdersCollectiveIdMismatch,
];

if (!module.parent) {
  runAllChecksThenExit(checks);
}
