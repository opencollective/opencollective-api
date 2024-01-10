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
    } else {
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

async function checkHostMemberEntry({ fix = false } = {}) {
  const message = 'No Collective with approved host without host member entry';

  const results = await sequelize.query(
    `SELECT COUNT(*) as count
     FROM "Collectives"
     WHERE "HostCollectiveId" IS NOT NULL
     AND "approvedAt" IS NOT NULL
     AND "isActive" IS TRUE
     AND "deletedAt" IS NULL
     AND "HostCollectiveId" != "Collectives"."id"
     AND NOT EXISTS (
       SELECT * FROM "Members"
       WHERE "CollectiveId" = "Collectives"."id"
       AND "role" = 'HOST'
       AND "deletedAt" IS NULL
     )
     AND EXISTS (
       SELECT * FROM "Collectives" c2
       WHERE "Collectives"."id" = c2."HostCollectiveId"
       AND c2."deletedAt" IS NULL
     )`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(
        `INSERT INTO "Members" (
           "createdAt",
           "updatedAt",
           "CreatedByUserId",
           "CollectiveId",
           "role",
           "MemberCollectiveId",
           "since"
         )
         SELECT
         NOW() as "createdAt",
         NOW() as "updatedAt",
         12457 as "CreatedByUserId",
         "Collectives"."id" as "CollectiveId",
         'HOST' as "role",
         "Collectives"."HostCollectiveId" as "MemberCollectiveId",
         "approvedAt" as "since"
         FROM "Collectives"
         WHERE "HostCollectiveId" IS NOT NULL
         AND "approvedAt" IS NOT NULL
         AND "isActive" IS TRUE
         AND "deletedAt" IS NULL
         AND "HostCollectiveId" != "Collectives"."id"
         AND NOT EXISTS (
           SELECT * FROM "Members"
           WHERE "CollectiveId" = "Collectives"."id"
           AND "role" = 'HOST'
           AND "deletedAt" IS NULL
         )
         AND EXISTS (
           SELECT * FROM "Collectives" c2
           WHERE "Collectives"."id" = c2."HostCollectiveId"
           AND c2."deletedAt" IS NULL
         )`,
      );
    }
  }
}
export async function checkHosts({ fix = false } = {}) {
  await checkHostFeePercent({ fix });

  await checkHostMemberEntry({ fix });
}

if (!module.parent) {
  runCheckThenExit(checkHosts);
}
