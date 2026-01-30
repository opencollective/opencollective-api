import '../../server/env';

import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

/**
 * Check for payout methods where the currency column doesn't match data.currency.
 * This includes:
 * - data.currency is set but currency column is NULL
 * - data.currency and currency column have different values
 *
 * No autofix, as we can't have certainty which currency is correct.
 */
async function checkPayoutMethodsCurrencyMismatch() {
  const message = 'Payout methods with currency mismatch between column and data';

  const results = (await sequelize.query(
    `
    SELECT id, type, currency, data->>'currency' as "dataCurrency"
    FROM "PayoutMethods"
    WHERE "deletedAt" IS NULL
    AND data->>'currency' IS NOT NULL
    AND (currency IS NULL OR currency != data->>'currency')
    `,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  )) as Array<{ id: number; type: string; currency: string | null; dataCurrency: string }>;

  if (results.length > 0) {
    throw new Error(`${message} (${results.length} found)`);
  }
}

export const checks = [checkPayoutMethodsCurrencyMismatch];

if (!module.parent) {
  runAllChecksThenExit(checks);
}
