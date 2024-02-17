import '../../server/env';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runCheckThenExit } from './_utils';

async function checkDeletedCollectives({ fix = false } = {}) {
  const message = 'No Transactions without a matching Collective';

  const results = await sequelize.query(
    `SELECT COUNT(*) as count
     FROM "Transactions" t
     LEFT JOIN "Collectives" c
     ON c."id" = t."CollectiveId"
     WHERE t."deletedAt" IS NULL
     AND (c."deletedAt" IS NOT NULL OR c."id" IS NULL)`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(
        `UPDATE "Transactions"
         SET "deletedAt" = NOW()
         FROM "Collectives" c
         WHERE c."id" = "Transactions"."CollectiveId"
         AND "Transactions"."deletedAt" IS NULL
         AND (c."deletedAt" IS NOT NULL OR c."id" IS NULL)`,
      );
      await sequelize.query(
        `UPDATE "Transactions"
         SET "deletedAt" = NOW()
         FROM "Collectives" c
         WHERE c."id" = "Transactions"."FromCollectiveId"
         AND "Transactions"."deletedAt" IS NULL
         AND (c."deletedAt" IS NOT NULL OR c."id" IS NULL)`,
      );
    }
  }
}

async function checkOrphanTransactions() {
  const message = 'No orphan Transaction without a primary Transaction (EXPENSE, CONTRIBUTION, ADDED_FUNDS)';

  const results = await sequelize.query(
    `SELECT COUNT(DISTINCT secondaryTransactions."TransactionGroup") as count
     FROM "Transactions" secondaryTransactions
     LEFT JOIN "Transactions" primaryTransactions
     ON primaryTransactions."TransactionGroup" = secondaryTransactions."TransactionGroup"
     AND primaryTransactions."deletedAt" IS NULL
     AND primaryTransactions."kind" IN ('EXPENSE', 'CONTRIBUTION', 'ADDED_FUNDS', 'BALANCE_TRANSFER', 'PREPAID_PAYMENT_METHOD')
     WHERE secondaryTransactions."kind" NOT IN ('EXPENSE', 'CONTRIBUTION', 'ADDED_FUNDS', 'BALANCE_TRANSFER', 'PREPAID_PAYMENT_METHOD')
     -- there are sometime issues WHERE PAYMENT_PROCESSOR_COVER end up with a different TransactionGroup
     -- this should be adressed separetely
     AND secondaryTransactions."kind" != 'PAYMENT_PROCESSOR_COVER'
     -- we have older entries with this issue
     -- for now, we just want to get alerts if this happen again in the future
     AND secondaryTransactions."createdAt" > '2024-01-01'
     AND secondaryTransactions."deletedAt" IS NULL
     AND primaryTransactions."id" IS NULL`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    // Not fixable
    throw new Error(message);
  }
}

async function checkOffBalancePaymentTransactions() {
  const message = 'No off balance payments (Stripe, PayPal) with HostCollectiveId set';

  // We only check /opencollective and /opensource as it's meant to be a non-regression check for those
  // The problem can still be seen on other accounts and that needs to be manually reviewed and fixed
  const results = await sequelize.query(
    `SELECT COUNT(*)
     FROM "Collectives" c
     INNER JOIN "Transactions" t ON t."CollectiveId" = c."id"
     LEFT JOIN "PaymentMethods" pm ON pm."id" = t."PaymentMethodId"
     WHERE c."HostCollectiveId" IN (8686, 11004) AND c."approvedAt" IS NOT NULL
     AND t."HostCollectiveId" IS NOT NULL
     AND t."deletedAt" IS NULL
     AND ( pm."service" IN ('stripe') OR pm."type" IN ('payment') )
     AND ( (t."type" = 'DEBIT' AND t."isRefund" IS FALSE) OR (t."type" = 'CREDIT' AND t."isRefund" IS TRUE) )
     AND c."id" NOT IN (8686, 11004)`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    // Not fixable
    throw new Error(message);
  }
}

export async function checkTransactions({ fix = false } = {}) {
  await checkDeletedCollectives({ fix });
  await checkOrphanTransactions();
  await checkOffBalancePaymentTransactions();
}

if (!module.parent) {
  runCheckThenExit(checkTransactions);
}
