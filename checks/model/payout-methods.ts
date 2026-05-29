import '../../server/env';

import { QueryTypes } from 'sequelize';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

/**
 * Check for payout methods where currency is NULL or doesn't match data.currency.
 */
export async function checkPayoutMethodsCurrencyMismatch({ fix = false } = {}) {
  const message = 'Payout methods with currency mismatch between column and data';

  const mismatchWhere = `
    "deletedAt" IS NULL
    AND data->>'currency' IS NOT NULL
    AND (currency IS NULL OR currency != data->>'currency')
  `;

  const results = await sequelize.query<{ count: string }>(
    `
    SELECT COUNT(*) AS count
    FROM "PayoutMethods"
    WHERE ${mismatchWhere}
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  const count = Number(results[0].count);
  if (count > 0) {
    if (!fix) {
      throw new Error(`${message} (${count} found)`);
    }

    logger.warn(`Fixing: setting currency from data`);
    const [, fixedCount] = await sequelize.query(
      `
      UPDATE "PayoutMethods"
      SET currency = data->>'currency'
      WHERE ${mismatchWhere}
      `,
      { type: QueryTypes.UPDATE },
    );
    logger.info(`Fixed: set currency on ${fixedCount} payout method(s) from data`);
  }
}

export const checks = [checkPayoutMethodsCurrencyMismatch];

if (!module.parent) {
  runAllChecksThenExit(checks);
}
