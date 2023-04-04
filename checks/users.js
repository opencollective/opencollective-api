import '../server/env';

import { sequelize } from '../server/models';
// import models, { Op } from '../server/models';

const check = true;
// const fix = false;

async function checkDeletedCollectives() {
  const results = await sequelize.query(
    `SELECT COUNT(*) as count
     FROM "Users" u
     LEFT JOIN "Collectives" c
     ON c."id" = u."CollectiveId"
     WHERE u."deletedAt" IS NULL
     AND (c."deletedAt" IS NOT NULL OR c."id" IS NULL)`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (check) {
      throw new Error('No Users without a matching Collective');
    }
  }
}

export async function checkUsers() {
  await checkDeletedCollectives();
}

if (!module.parent) {
  checkUsers();
}
