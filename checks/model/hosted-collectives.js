import '../../server/env';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runCheckThenExit } from './_utils';

async function checkHostFeePercent({ fix = false } = {}) {
  const message = 'Hosted Collectives without hostFeePercent';

  const results = await sequelize.query(
    `SELECT COUNT(*) as count
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
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
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

async function checkPendingHostApplications({ fix = false } = {}) {
  const message = 'Host Applications with status PENDING but Collective is approved to Host';

  const results = await sequelize.query(
    `SELECT COUNT(*) AS count
     FROM "HostApplications"
     INNER JOIN "Collectives"
         ON "Collectives"."id" = "HostApplications"."CollectiveId"
         AND "Collectives"."HostCollectiveId" = "HostApplications"."HostCollectiveId"
         AND "Collectives"."deletedAt" IS NULL
         AND "Collectives"."approvedAt" IS NOT NULL
     WHERE "HostApplications"."deletedAt" IS NULL
         AND "HostApplications"."status" = 'PENDING';`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(
        `UPDATE "HostApplications"
         SET "status" = 'APPROVED'
         FROM "Collectives"
         WHERE "Collectives"."id" = "HostApplications"."CollectiveId" 
             AND "Collectives"."HostCollectiveId" = "HostApplications"."HostCollectiveId"
             AND "Collectives"."deletedAt" IS NULL
             AND "Collectives"."approvedAt" IS NOT NULL
             AND "HostApplications"."deletedAt" IS NULL 
             AND "HostApplications"."status" = 'PENDING';`,
      );
    }
  }
}

export async function checkHostedCollectives({ fix = false } = {}) {
  await checkHostFeePercent({ fix });
  await checkPendingHostApplications({ fix });
}

if (!module.parent) {
  runCheckThenExit(checkHostedCollectives);
}
