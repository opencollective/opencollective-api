import '../../server/env';

import { sequelize } from '../../server/models';

async function checkDeletedCollectives() {
  const message = 'No Users without a matching Collective (no auto fix)';

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
    // Not fixable
    throw new Error(message);
  }
}

async function checkDeletedUsers() {
  const message = 'No Collectives type=USER without a matching User (no auto fix)';

  const results = await sequelize.query(
    `SELECT COUNT(*) as count
     FROM "Collectives" c
     LEFT JOIN "Users" u
     ON c."id" = u."CollectiveId"
     WHERE c."type" = 'USER' AND c."isIncognito" IS FALSE AND c."deletedAt" IS NULL
     AND (u."deletedAt" IS NOT NULL OR u."id" IS NULL)`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    // Not fixable
    throw new Error(message);
  }
}

export async function checkUsers() {
  await checkDeletedCollectives();
  await checkDeletedUsers();
}

if (!module.parent) {
  checkUsers();
}
