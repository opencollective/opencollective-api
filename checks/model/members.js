import '../../server/env';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

async function checkDeletedMembers({ fix = false } = {}) {
  const message = 'No non-deleted Members without a matching non-deleted Collective';

  const results = await sequelize.query(
    `SELECT COUNT(*) as count
     FROM "Members" m
     LEFT JOIN "Collectives" c1
     ON c1."id" = m."CollectiveId"
     LEFT JOIN "Collectives" c2
     ON c2."id" = m."MemberCollectiveId"
     WHERE m."deletedAt" IS NULL
     AND (c1."deletedAt" IS NOT NULL OR c1."id" IS NULL OR c2."deletedAt" IS NOT NULL OR c2."id" IS NULL)`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    if (!fix) {
      throw new Error(message);
    }
    if (fix) {
      logger.warn(`Fixing: ${message}`);
      await sequelize.query(
        `UPDATE "Members"
         SET "deletedAt" = NOW()
         FROM "Collectives" c1, "Collectives" c2
         WHERE "Members"."deletedAt" IS NULL
         AND c1."id" = "Members"."CollectiveId"
         AND c2."id" = "Members"."MemberCollectiveId"
         AND (c1."deletedAt" IS NOT NULL OR c1."id" IS NULL OR c2."deletedAt" IS NOT NULL OR c2."id" IS NULL)`,
      );
    }
  }
}

async function checkMemberTypes() {
  const message = 'No ACCOUNTANT OR ADMIN member with a type different than USER (no auto fix)';

  const results = await sequelize.query(
    `SELECT COUNT(*)
     FROM "Members" as m
     LEFT JOIN "Users" u ON u."CollectiveId" = m."MemberCollectiveId"
     LEFT JOIN "Collectives" c ON c."id" = m."MemberCollectiveId"
     LEFT JOIN "Collectives" c1 ON c1."id" = m."CollectiveId"
     WHERE m."role" IN ('ACCOUNTANT', 'ADMIN')
     AND m."deletedAt" IS NULL
     AND u."id" IS NULL
     AND c."type" != 'USER'`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    // Not fixable
    throw new Error(message);
  }
}

export async function checkMembers({ fix = false } = {}) {
  await checkDeletedMembers({ fix });
  await checkMemberTypes();
}

if (!module.parent) {
  checkMembers();
}
