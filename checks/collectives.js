import '../server/env';

import { sequelize } from '../server/models';
// import models, { Op } from '../server/models';

const check = true;
// const fix = false;

async function checkDeletedUsers() {
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
    if (check) {
      throw new Error('No USER Collective without a matching User');
    }
  }
}

export async function checkCollectives() {
  await checkDeletedUsers();
}

if (!module.parent) {
  checkCollectives();
}
