import '../../server/env';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runCheckThenExit } from './_utils';

async function checkDeletedVirtualCardsWithExpenses({ fix = false } = {}) {
  const message = 'Deleted Virtual Cards with non-deleted Expenses ';

  const results = await sequelize.query(
    `SELECT COUNT(*) as count
     FROM "VirtualCards", "Expenses"
     WHERE "VirtualCards"."id" = "Expenses"."VirtualCardId"
     AND "VirtualCards"."deletedAt" IS NOT NULL
     AND "VirtualCards"."provider" = 'STRIPE'
     GROUP BY "VirtualCards"."id"`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(
        `UPDATE "VirtualCards"
         SET "deletedAt" = NULL
         FROM "Expenses"
         WHERE "VirtualCards"."id" = "Expenses"."VirtualCardId"
         AND "VirtualCards"."deletedAt" IS NOT NULL
         AND "VirtualCards"."provider" = 'STRIPE'`,
      );
    }
  }
}

export async function checkVirtualCards({ fix = false } = {}) {
  await checkDeletedVirtualCardsWithExpenses({ fix });
}

if (!module.parent) {
  runCheckThenExit(checkVirtualCards);
}
