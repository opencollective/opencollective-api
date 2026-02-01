import '../../server/env';

import { sql } from '@ts-safeql/sql-tag';
import { QueryTypes } from 'sequelize';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

async function checkIsActive({ fix = false } = {}) {
  const message = 'Independent Collectives without isActive=TRUE';

  const results = await sequelize.query<{ count: number }>(
    sql`
     SELECT COUNT(*) as count
     FROM "Collectives"
     WHERE "isActive" IS FALSE
     AND "approvedAt" IS NOT NULL
     AND "deletedAt" IS NULL
     AND "hasMoneyManagement" IS TRUE
     AND "type" = 'COLLECTIVE'
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(sql`
        UPDATE "Collectives"
         SET "isActive" = TRUE, "updatedAt" = NOW()
         WHERE "isActive" IS FALSE
         AND "approvedAt" IS NOT NULL
         AND "deletedAt" IS NULL
         AND "hasMoneyManagement" IS TRUE
         AND "type" = 'COLLECTIVE'
      `);
    }
  }
}

async function checkHasHostCollectiveId({ fix = false } = {}) {
  const message = 'Independent Collectives without HostCollectiveId set';

  const results = await sequelize.query<{ count: number }>(
    sql`
     SELECT COUNT(*) as count
     FROM "Collectives"
     WHERE "HostCollectiveId" IS NULL
     AND "approvedAt" IS NOT NULL
     AND "deletedAt" IS NULL
     AND "hasMoneyManagement" IS TRUE
     AND "type" = 'COLLECTIVE'
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(sql`
        UPDATE "Collectives"
         SET "HostCollectiveId" = "id", "updatedAt" = NOW()
         WHERE "isActive" IS FALSE
         AND "approvedAt" IS NOT NULL
         AND "deletedAt" IS NULL
         AND "hasMoneyManagement" IS TRUE
         AND "type" = 'COLLECTIVE'
      `);
    }
  }
}

async function checkApprovedAt({ fix = false } = {}) {
  const message = 'Independent Collectives with approvedAt=null';

  const results = await sequelize.query<{ count: number }>(
    sql`
     SELECT COUNT(*) as count
     FROM "Collectives"
     WHERE "approvedAt" IS NULL
     AND "deletedAt" IS NULL
     AND "hasMoneyManagement" IS TRUE
     AND "HostCollectiveId" = "id"
     AND "type" = 'COLLECTIVE'
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(sql`
        UPDATE "Collectives"
         SET "approvedAt" = NOW(), "updatedAt" = NOW()
         WHERE "approvedAt" IS NULL
         AND "deletedAt" IS NULL
         AND "hasMoneyManagement" IS TRUE
         AND "HostCollectiveId" = "id"
         AND "type" = 'COLLECTIVE'
      `);
    }
  }
}

async function checkIsHostAccount({ fix = false } = {}) {
  const message = 'Non-Independent Collectives with hasMoneyManagement=TRUE';

  const results = await sequelize.query<{ count: number }>(
    sql`
     SELECT COUNT(*) as count
     FROM "Collectives"
     WHERE "deletedAt" IS NULL
     AND "hasMoneyManagement" IS TRUE
     AND "HostCollectiveId" != "id"
     AND "type" = 'COLLECTIVE'
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(sql`
        UPDATE "Collectives"
         SET "hasMoneyManagement" = FALSE, "updatedAt" = NOW()
         WHERE "deletedAt" IS NULL
         AND "hasMoneyManagement" IS TRUE
         AND "HostCollectiveId" != "id"
         AND "type" = 'COLLECTIVE'
      `);
    }
  }
}

async function checkHostFeePercent({ fix = false } = {}) {
  const message = 'Independent Collectives with hostFeePercent != 0';

  const results = await sequelize.query<{ count: number }>(
    sql`
     SELECT COUNT(*) as count
     FROM "Collectives"
     WHERE ("hostFeePercent" IS NULL OR "hostFeePercent" > 0)
     AND "deletedAt" IS NULL
     AND "hasMoneyManagement" IS TRUE
     AND "HostCollectiveId" = "id"
     AND "type" = 'COLLECTIVE'
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(sql`
        UPDATE "Collectives"
         SET "hostFeePercent" = 0, "updatedAt" = NOW()
         WHERE ("hostFeePercent" IS NULL OR "hostFeePercent" > 0)
         AND "deletedAt" IS NULL
         AND "hasMoneyManagement" IS TRUE
         AND "HostCollectiveId" = "id"
         AND "type" = 'COLLECTIVE'
      `);
    }
  }
}

export const checks = [
  checkIsActive,
  checkHasHostCollectiveId,
  checkApprovedAt,
  checkIsHostAccount,
  checkHostFeePercent,
];

if (!module.parent) {
  runAllChecksThenExit(checks);
}
