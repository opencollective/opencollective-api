import '../../server/env';

import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

async function checkTiersMinimumAmountWithPresets({ fix = false } = {}) {
  const message = 'Tiers presets cannot be lower than the minimum amount';
  const results = await sequelize.query(
    `
    SELECT COUNT(*) AS count
    FROM "Tiers"
    WHERE presets IS NOT NULL
    AND ARRAY_LENGTH(presets, 1) > 0
    AND "minimumAmount" > (SELECT MIN(val) FROM UNNEST(presets) val)  
  `,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (!fix) {
      throw new Error(`${message} (${results[0].count} found)`);
    }

    await sequelize.query(`
      UPDATE "Tiers"
      SET
        "minimumAmount" = (SELECT MIN(val) FROM UNNEST(presets) val),
        "data" = JSONB_SET(COALESCE("data", '{}'), '{minimumAmountBeforeCheckFix}', "minimumAmount"::TEXT::JSONB)
      WHERE presets IS NOT NULL
      AND ARRAY_LENGTH(presets, 1) > 0
      AND "minimumAmount" > (SELECT MIN(val) FROM UNNEST(presets) val)
    `);
  }
}

export const checks = [checkTiersMinimumAmountWithPresets];

if (!module.parent) {
  runAllChecksThenExit(checks);
}
