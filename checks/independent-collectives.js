import '../server/env';

import { sequelize } from '../server/models';
// import models, { Op } from '../server/models';

const check = true;
const fix = false;

async function checkIsActive() {
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
    if (check) {
      throw new Error('Independent Collectives without isActive=TRUE');
    }
    if (fix) {
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

async function checkHasHostCollectiveId() {
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
    if (check) {
      throw new Error('Independent Collectives without HostCollectiveId set');
    }
    if (fix) {
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

async function checkApprovedAt() {
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
    if (check) {
      throw new Error('Independent Collectives with approvedAt=null');
    }
    if (fix) {
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

async function checkIsHostAccount() {
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
    if (check) {
      throw new Error('Non-Independent Collectives with isHostAccount=TRUE');
    }
    if (fix) {
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

async function checkHostFeePercent() {
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
    if (check) {
      throw new Error('Independent Collectives with hostFeePercent != 0');
    }
    if (fix) {
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

export async function checkIndepedentCollectives() {
  await checkIsActive();
  await checkHasHostCollectiveId();
  await checkApprovedAt();
  await checkIsHostAccount();
  await checkHostFeePercent();
}

if (!module.parent) {
  checkIndepedentCollectives();
}
