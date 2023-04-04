import '../server/env';

import { sequelize } from '../server/models';
// import models, { Op } from '../server/models';

const check = true;
const fix = false;

async function checkHostFeePercent() {
  const results = await sequelize.query(
    `SELECT *
     FROM "Collectives"
     WHERE "isActive" IS TRUE
     AND "deletedAt" IS NULL
     AND "hostFeePercent" IS NULL
     AND "isHostAccount" IS FALSE
     AND "ParentCollectiveId" IS NULL
     AND "HostCollectiveId" IS NOT NULL
     AND "type" NOT IN ('ORGANIZATION', 'USER')`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (check) {
      throw new Error('Hosted Collectives without hostFeePercent');
    }
    if (fix) {
      await sequelize.query(
        `UPDATE "Collectives"
         SET "hostFeePercent" = host."hostFeePercent"
         FROM "Collectives" host
         WHERE host."id" = "Collectives"."HostCollectiveId"
         AND "Collectives"."isActive" IS TRUE
         AND "Collectives"."deletedAt" IS NULL
         AND "Collectives"."hostFeePercent" IS NULL
         AND "Collectives"."isHostAccount" IS FALSE
         AND "Collectives"."ParentCollectiveId" IS NULL
         AND "Collectives"."HostCollectiveId" IS NOT NULL
         AND "Collectives"."type" NOT IN ('ORGANIZATION', 'USER')`,
      );
    }
  }
}

export async function checkHostedCollectives() {
  await checkHostFeePercent();
}

if (!module.parent) {
  checkHostedCollectives();
}
