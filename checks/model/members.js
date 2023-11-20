import '../../server/env';

import { flatten, uniq } from 'lodash';

import logger from '../../server/lib/logger';
import { MigrationLog, sequelize } from '../../server/models';
import { MigrationLogType } from '../../server/models/MigrationLog';

import { runCheckThenExit } from './_utils';

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

async function checkDuplicateMembers({ fix = false } = {}) {
  const message = 'No duplicate members';

  const results = await sequelize.query(
    `SELECT ARRAY_AGG(DISTINCT m2.id) AS duplicate_ids
     FROM "Members" m1
     INNER JOIN "Members" m2
       ON m1.id != m2.id
       AND m1."CollectiveId" = m2."CollectiveId"
       AND m1."MemberCollectiveId" = m2."MemberCollectiveId"
       AND m1."role" = m2."role"
       AND (m1."TierId" = m2."TierId" OR (m1."TierId" IS NULL AND m2."TierId" IS NULL))
     WHERE m1."deletedAt" IS NULL
     AND m2."deletedAt" IS NULL
     GROUP BY m1.id
    `,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    if (!fix) {
      throw new Error(message);
    }
    if (fix) {
      logger.warn(`Fixing: ${message}`);
      const allDuplicateIds = uniq(flatten(results.map(r => r.duplicate_ids)));
      await sequelize.query(
        `UPDATE "Members"
         SET "deletedAt" = NOW()
         WHERE "Members"."id" IN (:allDuplicateIds)
         AND "Members"."deletedAt" IS NULL`,
        { replacements: { allDuplicateIds } },
      );

      // Members don't have a `data` column that we could use to log that they've been deleted from this script, so we
      // create a new migration log instead.
      await MigrationLog.create({
        type: MigrationLogType.MODEL_FIX,
        description: `Deleted ${results[0].nb_duplicates} duplicate members`,
        data: { duplicateMemberIds: allDuplicateIds },
      });
    }
  }
}

export async function checkMembers({ fix = false } = {}) {
  await checkDeletedMembers({ fix });
  await checkMemberTypes();
  await checkDuplicateMembers({ fix });
}

if (!module.parent) {
  runCheckThenExit(checkMembers);
}
