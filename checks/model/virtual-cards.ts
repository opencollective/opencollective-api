import '../../server/env';

import { QueryTypes } from 'sequelize';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

async function checkDeletedVirtualCardsWithExpenses({ fix = false } = {}) {
  const message = 'Deleted Virtual Cards with non-deleted Expenses ';

  const results = await sequelize.query<{ count: number }>(
    `
     SELECT COUNT(*) as count
     FROM "VirtualCards", "Expenses"
     WHERE "VirtualCards"."id" = "Expenses"."VirtualCardId"
     AND "Expenses"."deletedAt" IS NULL
     AND "VirtualCards"."deletedAt" IS NOT NULL
     AND "VirtualCards"."provider" = 'STRIPE'
     GROUP BY "VirtualCards"."id"
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results[0]?.count > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(`
        UPDATE "VirtualCards"
         SET "deletedAt" = NULL
         FROM "Expenses"
         WHERE "VirtualCards"."id" = "Expenses"."VirtualCardId"
         AND "Expenses"."deletedAt" IS NULL
         AND "VirtualCards"."deletedAt" IS NOT NULL
         AND "VirtualCards"."provider" = 'STRIPE'
      `);
    }
  }
}

export const checks = [checkDeletedVirtualCardsWithExpenses];

if (!module.parent) {
  runAllChecksThenExit(checks);
}
