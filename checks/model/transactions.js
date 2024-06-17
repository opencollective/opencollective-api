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
     AND secondaryTransactions."kind" NOT IN ('PAYMENT_PROCESSOR_COVER', 'PAYMENT_PROCESSOR_DISPUTE_FEE')
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

async function checkUniqueUuid() {
  const message = 'No Transaction with duplicate UUID';

  const results = await sequelize.query(
    `SELECT "uuid"
     FROM "Transactions"
     WHERE "deletedAt" IS NULL
     GROUP BY "uuid"
     HAVING COUNT(*) > 1`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    // Not fixable
    throw new Error(message);
  }
}

async function checkUniqueTransactionGroup() {
  const message = 'No duplicate TransactionGroup';

  const results = await sequelize.query(
    `SELECT "TransactionGroup"
    FROM "Transactions"
    WHERE "kind" IN ('EXPENSE', 'CONTRIBUTION', 'ADDED_FUNDS', 'BALANCE_TRANSFER', 'PREPAID_PAYMENT_METHOD')
    AND "deletedAt" IS NULL
    GROUP BY "TransactionGroup"
    HAVING COUNT(*) > 2`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    // Not fixable
    throw new Error(message);
  }
}

export async function checkTransactions({ fix = false } = {}) {
  await checkDeletedCollectives({ fix });
  await checkOrphanTransactions();
  await checkUniqueUuid();
  await checkUniqueTransactionGroup();
}

if (!module.parent) {
  runCheckThenExit(checkTransactions);
}
