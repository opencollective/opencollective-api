import '../../server/env';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

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
    }
    if (fix) {
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
    `SELECT COUNT(*)
     FROM "Transactions" t1
     INNER JOIN "Transactions" t2 ON t1."TransactionGroup" = t2."TransactionGroup"
     AND t2."kind" NOT IN ('EXPENSE', 'CONTRIBUTION', 'ADDED_FUNDS') AND t2."deletedAt" IS NULL
     LEFT JOIN "Transactions" t3 ON t3."TransactionGroup" = t2."TransactionGroup"
     AND t3."kind" IN ('EXPENSE', 'CONTRIBUTION', 'ADDED_FUNDS') AND t3."deletedAt" IS NULL
     WHERE t1."kind" IN ('EXPENSE', 'CONTRIBUTION', 'ADDED_FUNDS') AND t1."deletedAt" IS NOT NULL
     AND t3."id" IS NULL`,
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
  checkTransactions();
}
