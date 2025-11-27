import '../../server/env';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

async function checkDeletedUsers() {
  const message = 'No USER Collective without a matching User (no auto fix)';

  const results = await sequelize.query(
    `SELECT COUNT(*) as count
     FROM "Collectives" c
     LEFT JOIN "Users" u
     ON c."id" = u."CollectiveId"
     WHERE c."type" = 'USER'
     AND c."isIncognito" IS FALSE
     AND c."deletedAt" IS NULL
     AND (u."deletedAt" IS NOT NULL or u."id" IS NULL)`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    // Not fixable
    throw new Error(message);
  }
}

async function checkActiveApprovedAtInconsistency() {
  const message = 'approvedAt and isActive are inconsistent (no auto fix)';

  const [results] = await sequelize.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE "isActive" IS TRUE and "approvedAt" IS NULL) as "activeUnapproved",
      COUNT(*) FILTER (WHERE "isActive" IS NOT TRUE and "approvedAt" IS NOT NULL) as "inactiveApproved"
    FROM "Collectives"
    WHERE "deletedAt" IS NULL
    AND (
      ("isActive" IS TRUE and "approvedAt" IS NULL)
      OR ("isActive" IS NOT TRUE and "approvedAt" IS NOT NULL)
    )`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results.activeUnapproved > 0 || results.inactiveApproved > 0) {
    throw new Error(
      `${message} (${results.activeUnapproved} activeUnapproved, ${results.inactiveApproved} inactiveApproved)`,
    );
  }
}

async function checkNonActiveHostOrganizations({ fix = false } = {}) {
  const results = await sequelize.query(
    `
    SELECT COUNT(*) as count FROM "Collectives"
    WHERE "deletedAt" is null
      AND "isHostAccount" is true
      AND "isActive" is FALSE
      AND type = 'ORGANIZATION';
    `,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    const message = `Host Organizations must be active, found ${results[0].count} inactive ones.`;
    if (fix) {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(`
        UPDATE "Collectives"
        SET "isActive" = true
        WHERE "deletedAt" is null
          AND "isHostAccount" is true
          AND "isActive" is FALSE
          AND type = 'ORGANIZATION';
      `);
    } else {
      throw new Error(message);
    }
  }
}

export const checks = [checkDeletedUsers, checkActiveApprovedAtInconsistency, checkNonActiveHostOrganizations];

if (!module.parent) {
  runAllChecksThenExit(checks);
}
