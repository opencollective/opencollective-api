import '../server/env';

import { sequelize } from '../server/models';
// import models, { Op } from '../server/models';

const check = true;
const fix = false;

async function checkHostFeePercent() {
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
    if (check) {
      throw new Error('Hosts should have hostFeePercent set');
    }
    if (fix) {
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

export async function checkHosts() {
  await checkHostFeePercent();
}

if (!module.parent) {
  checkHosts();
}
