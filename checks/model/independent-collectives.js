import '../../server/env';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runCheckThenExit } from './_utils';

async function checkIsActive({ fix = false } = {}) {
  const message = 'Independent Collectives without isActive=TRUE';

  const results = await sequelize.query(
    `SELECT COUNT(*) as count
     FROM "Collectives"
     WHERE "isActive" IS FALSE
     AND "approvedAt" IS NOT NULL
     AND "deletedAt" IS NULL
     AND "isHostAccount" IS TRUE
     AND "type" = 'COLLECTIVE'`,
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
         SET "isActive" = TRUE, "updatedAt" = NOW()
         WHERE "isActive" IS FALSE
         AND "approvedAt" IS NOT NULL
         AND "deletedAt" IS NULL
         AND "isHostAccount" IS TRUE
         AND "type" = 'COLLECTIVE'`,
      );
    }
  }
}

async function checkHasHostCollectiveId({ fix = false } = {}) {
  const message = 'Independent Collectives without HostCollectiveId set';

  const results = await sequelize.query(
    `SELECT COUNT(*) as count
     FROM "Collectives"
     WHERE "HostCollectiveId" IS NULL
     AND "approvedAt" IS NOT NULL
     AND "deletedAt" IS NULL
     AND "isHostAccount" IS TRUE
     AND "type" = 'COLLECTIVE'`,
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
         SET "HostCollectiveId" = "id", "updatedAt" = NOW()
         WHERE "isActive" IS FALSE
         AND "approvedAt" IS NOT NULL
         AND "deletedAt" IS NULL
         AND "isHostAccount" IS TRUE
         AND "type" = 'COLLECTIVE'`,
      );
    }
  }
}

async function checkApprovedAt({ fix = false } = {}) {
  const message = 'Independent Collectives with approvedAt=null';

  const results = await sequelize.query(
    `SELECT COUNT(*) as count
     FROM "Collectives"
     WHERE "approvedAt" IS NULL
     AND "deletedAt" IS NULL
     AND "isHostAccount" IS TRUE
     AND "HostCollectiveId" = "id"
     AND "type" = 'COLLECTIVE'`,
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
         SET "approvedAt" = NOW(), "updatedAt" = NOW()
         WHERE "approvedAt" IS NULL
         AND "deletedAt" IS NULL
         AND "isHostAccount" IS TRUE
         AND "HostCollectiveId" = "id"
         AND "type" = 'COLLECTIVE'`,
      );
    }
  }
}

async function checkIsHostAccount({ fix = false } = {}) {
  const message = 'Non-Independent Collectives with isHostAccount=TRUE';

  const results = await sequelize.query(
    `SELECT COUNT(*) as count
     FROM "Collectives"
     WHERE "deletedAt" IS NULL
     AND "isHostAccount" IS TRUE
     AND "HostCollectiveId" != "id"
     AND "type" = 'COLLECTIVE'`,
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
         SET "isHostAccount" = FALSE, "updatedAt" = NOW()
         WHERE "deletedAt" IS NULL
         AND "isHostAccount" IS TRUE
         AND "HostCollectiveId" != "id"
         AND "type" = 'COLLECTIVE'`,
      );
    }
  }
}

async function checkHostFeePercent({ fix = false } = {}) {
  const message = 'Independent Collectives with hostFeePercent != 0';

  const results = await sequelize.query(
    `SELECT COUNT(*) as count
     FROM "Collectives"
     WHERE ("hostFeePercent" IS NULL OR "hostFeePercent" > 0)
     AND "deletedAt" IS NULL
     AND "isHostAccount" IS TRUE
     AND "HostCollectiveId" = "id"
     AND "type" = 'COLLECTIVE'`,
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
         SET "hostFeePercent" = 0, "updatedAt" = NOW()
         WHERE ("hostFeePercent" IS NULL OR "hostFeePercent" > 0)
         AND "deletedAt" IS NULL
         AND "isHostAccount" IS TRUE
         AND "HostCollectiveId" = "id"
         AND "type" = 'COLLECTIVE'`,
      );
    }
  }
}

export async function checkIndependentCollectives({ fix = false } = {}) {
  await checkIsActive({ fix });
  await checkHasHostCollectiveId({ fix });
  await checkApprovedAt({ fix });
  await checkIsHostAccount({ fix });
  await checkHostFeePercent({ fix });
}

if (!module.parent) {
  runCheckThenExit(checkIndependentCollectives);
}
