import '../../server/env';

import { sequelize } from '../../server/models';

async function checkDeletedUsers() {
  const message = 'No USER Collective without a matching User';

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

export async function checkCollectives() {
  await checkDeletedUsers();
}

if (!module.parent) {
  checkCollectives();
}
