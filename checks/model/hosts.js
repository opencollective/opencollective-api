import '../../server/env';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runCheckThenExit } from './_utils';

async function checkHostFeePercent({ fix = false } = {}) {
  const message = 'Host without hostFeePercent';

  const results = await sequelize.query(
    `SELECT COUNT(*) as count
     FROM "Collectives"
     WHERE "deletedAt" IS NULL
     AND "hostFeePercent" IS NULL
     AND "isHostAccount" IS TRUE
     AND "type" IN ('ORGANIZATION', 'USER')`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (!fix) {
      throw new Error(message);
    }
    if (fix) {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(
        `UPDATE "Collectives"
         SET "hostFeePercent" = 0
         WHERE "deletedAt" IS NULL
         AND "hostFeePercent" IS NULL
         AND "isHostAccount" IS TRUE
         AND "type" IN ('ORGANIZATION', 'USER')`,
      );
    }
  }
}

export async function checkHosts({ fix = false } = {}) {
  await checkHostFeePercent({ fix });
}

if (!module.parent) {
  runCheckThenExit(checkHosts);
}
