import '../../server/env';

import { QueryTypes } from 'sequelize';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

async function checkHostFeePercent({ fix = false } = {}) {
  const message = 'Hosted Collectives without hostFeePercent';

  const results = await sequelize.query<{ count: number }>(
    `
     SELECT COUNT(*) as count
     FROM "Collectives"
     WHERE "isActive" IS TRUE
     AND "deletedAt" IS NULL
     AND "hostFeePercent" IS NULL
     AND "hasMoneyManagement" IS FALSE
     AND "ParentCollectiveId" IS NULL
     AND "HostCollectiveId" IS NOT NULL
     AND "type" NOT IN ('ORGANIZATION', 'USER')
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(`
        UPDATE "Collectives"
         SET "hostFeePercent" = host."hostFeePercent"
         FROM "Collectives" host
         WHERE host."id" = "Collectives"."HostCollectiveId"
         AND "Collectives"."isActive" IS TRUE
         AND "Collectives"."deletedAt" IS NULL
         AND "Collectives"."hostFeePercent" IS NULL
         AND "Collectives"."hasMoneyManagement" IS FALSE
         AND "Collectives"."ParentCollectiveId" IS NULL
         AND "Collectives"."HostCollectiveId" IS NOT NULL
         AND "Collectives"."type" NOT IN ('ORGANIZATION', 'USER')
      `);
    }
  }
}

/** Hosted accounts whose fiscal host is private must have isPrivate (see Collective.beforeCreate). */
export async function checkHostedAccountsPrivateUnderPrivateHost({ fix = false } = {}) {
  const message =
    'Collectives hosted by a private fiscal host without isPrivate=true (hosted accounts must match host privacy)';

  const results = await sequelize.query<{ count: number }>(
    `
     SELECT COUNT(*)::int AS count
     FROM "Collectives" AS child
     INNER JOIN "Collectives" AS host ON host."id" = child."HostCollectiveId"
     WHERE child."deletedAt" IS NULL
       AND host."deletedAt" IS NULL
       AND host."id" <> child."id"
       AND host."isPrivate" IS TRUE
       AND child."isPrivate" IS NOT TRUE
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (!fix) {
      throw new Error(`${message}: ${results[0].count}`);
    }
    logger.warn(`Fixing: ${message}`);
    await sequelize.query(`
      UPDATE "Collectives" AS child
      SET "isPrivate" = TRUE
      FROM "Collectives" AS host
      WHERE host."id" = child."HostCollectiveId"
        AND child."deletedAt" IS NULL
        AND host."deletedAt" IS NULL
        AND host."id" <> child."id"
        AND host."isPrivate" IS TRUE
        AND child."isPrivate" IS NOT TRUE
    `);
  }
}

async function checkPendingHostApplications({ fix = false } = {}) {
  const message = 'Host Applications with status PENDING but Collective is approved to Host';

  const results = await sequelize.query<{ count: number }>(
    `
     SELECT COUNT(*) AS count
     FROM "HostApplications"
     INNER JOIN "Collectives"
         ON "Collectives"."id" = "HostApplications"."CollectiveId"
         AND "Collectives"."HostCollectiveId" = "HostApplications"."HostCollectiveId"
         AND "Collectives"."deletedAt" IS NULL
         AND "Collectives"."approvedAt" IS NOT NULL
     WHERE "HostApplications"."deletedAt" IS NULL
         AND "HostApplications"."status" = 'PENDING';
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(`
        UPDATE "HostApplications"
         SET "status" = 'APPROVED'
         FROM "Collectives"
         WHERE "Collectives"."id" = "HostApplications"."CollectiveId"
             AND "Collectives"."HostCollectiveId" = "HostApplications"."HostCollectiveId"
         AND "Collectives"."deletedAt" IS NULL
         AND "Collectives"."approvedAt" IS NOT NULL
         AND "HostApplications"."deletedAt" IS NULL
         AND "HostApplications"."status" = 'PENDING';
      `);
    }
  }
}

export const checks = [checkHostFeePercent, checkHostedAccountsPrivateUnderPrivateHost, checkPendingHostApplications];

if (!module.parent) {
  runAllChecksThenExit(checks);
}
