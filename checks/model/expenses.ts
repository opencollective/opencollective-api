import '../../server/env';

import { QueryTypes } from 'sequelize';

import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

/**
 * Check that paid expenses have accounting categories belonging to the host that processed the payment.
 * Uses Transaction.HostCollectiveId (kind=EXPENSE, type=DEBIT) as the source of truth.
 */
async function checkAccountingCategoryHostIntegrity() {
  const message = 'No paid expenses with accounting categories belonging to the wrong host (no auto fix)';

  const results = await sequelize.query<{ expense_id: number }>(
    `
    SELECT e.id AS expense_id
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
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    throw new Error(`${message} (found ${results.length})`);
  }
}

export const checks = [checkAccountingCategoryHostIntegrity];

if (!module.parent) {
  runAllChecksThenExit(checks);
}
