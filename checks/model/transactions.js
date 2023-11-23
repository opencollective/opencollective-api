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
     AND secondaryTransactions."deletedAt" IS NULL
     AND primaryTransactions."id" IS NULL`,
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
}

if (!module.parent) {
  runCheckThenExit(checkTransactions);
}
