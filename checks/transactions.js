import '../server/env';

import { sequelize } from '../server/models';
// import models, { Op } from '../server/models';

const check = true;
const fix = false;

async function checkDeletedCollectives() {
  const results = await sequelize.query(
    `SELECT COUNT(*) as count
     FROM "Transactions" t
     LEFT JOIN "Collectives" c
     ON c."id" = t."CollectiveId"
     WHERE t."deletedAt" IS NULL
     AND (c."deletedAt" IS NOT NULL OR c."id" IS NULL)`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (check) {
      throw new Error('No Transactions without a matching Collective');
    }
    if (fix) {
      await sequelize.query(
        `UPDATE "Transactions"
         SET "deletedAt" = NOW()
         FROM "Collectives" c
         WHERE c."id" = "Transactions"."CollectiveId"
         AND "Transactions"."deletedAt" IS NULL
         AND (c."deletedAt" IS NOT NULL OR c."id" IS NULL)`,
      );
      await sequelize.query(
        `UPDATE "Transactions"
         SET "deletedAt" = NOW()
         FROM "Collectives" c
         WHERE c."id" = "Transactions"."FromCollectiveId"
         AND "Transactions"."deletedAt" IS NULL
         AND (c."deletedAt" IS NOT NULL OR c."id" IS NULL)`,
      );
    }
  }
}

export async function checkTransactions() {
  await checkDeletedCollectives();
}

if (!module.parent) {
  checkTransactions();
}
