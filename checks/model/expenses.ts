import '../../server/env';

import { QueryTypes } from 'sequelize';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

/**
 * Check that paid expenses have accounting categories belonging to the host that processed the payment.
 * Uses Transaction.HostCollectiveId (kind=EXPENSE, type=DEBIT) as the source of truth.
 */
async function checkAccountingCategoryHostIntegrity({ fix = false } = {}) {
  const message = 'Paid expenses with accounting categories belonging to the wrong host';

  const results = await sequelize.query(
    `
    SELECT
      e.id,
      e.description,
      e."createdAt",
      e."updatedAt",
      c.id AS "CollectiveId",
      c.slug,
      t."HostCollectiveId",
      ac.id AS "AccountingCategoryId",
      ac.name AS "AccountingCategoryName",
      ac."CollectiveId" AS "AccountingCategoryHostId"
    FROM "Expenses" e
    JOIN "Transactions" t ON t."ExpenseId" = e.id
      AND t.kind = 'EXPENSE'
      AND t.type = 'DEBIT'
      AND t."deletedAt" IS NULL
      AND t."isRefund" IS NOT TRUE
      AND t."RefundTransactionId" IS NULL
    JOIN "AccountingCategories" ac ON e."AccountingCategoryId" = ac.id
    JOIN "Collectives" c ON c.id = e."CollectiveId"
    WHERE e."AccountingCategoryId" IS NOT NULL
      AND e."deletedAt" IS NULL
      AND ac."CollectiveId" != t."HostCollectiveId"
    ORDER BY e."createdAt" DESC
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    logger.warn(`Mismatched rows:\n${JSON.stringify(results, null, 2)}`);

    if (fix) {
      logger.warn(`Fixing: ${message} (resetting AccountingCategoryId on ${results.length} expenses)`);
      const [, count] = await sequelize.query(
        `
        UPDATE "Expenses"
        SET "AccountingCategoryId" = NULL
        WHERE id IN (
          SELECT e.id
          FROM "Expenses" e
          JOIN "Transactions" t ON t."ExpenseId" = e.id
            AND t.kind = 'EXPENSE'
            AND t.type = 'DEBIT'
            AND t."deletedAt" IS NULL
            AND t."isRefund" IS NOT TRUE
            AND t."RefundTransactionId" IS NULL
          JOIN "AccountingCategories" ac ON e."AccountingCategoryId" = ac.id
          WHERE e."AccountingCategoryId" IS NOT NULL
            AND e."deletedAt" IS NULL
            AND ac."CollectiveId" != t."HostCollectiveId"
        )
        `,
        { type: QueryTypes.UPDATE },
      );
      logger.info(`Fixed: reset AccountingCategoryId on ${count} expenses`);
    } else {
      throw new Error(`${message} (found ${results.length})`);
    }
  }
}

export const checks = [checkAccountingCategoryHostIntegrity];

if (!module.parent) {
  runAllChecksThenExit(checks);
}
