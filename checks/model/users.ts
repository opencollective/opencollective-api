import '../../server/env';

import { QueryTypes } from 'sequelize';

import logger from '../../server/lib/logger';
import { mergeAccounts } from '../../server/lib/merge-accounts';
import models, { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

async function checkDeletedCollectives() {
  const message = 'No Users without a matching Collective (no auto fix)';

  const results = await sequelize.query<{ count: number }>(
    `
     SELECT COUNT(*) as count
     FROM "Users" u
     LEFT JOIN "Collectives" c
     ON c."id" = u."CollectiveId"
     WHERE u."deletedAt" IS NULL
     AND (c."deletedAt" IS NOT NULL OR c."id" IS NULL)
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    // Not fixable
    throw new Error(message);
  }
}

async function checkDeletedUsers() {
  const message = 'No Collectives type=USER without a matching User (no auto fix)';

  const results = await sequelize.query<{ count: number }>(
    `
     SELECT COUNT(*) as count
     FROM "Collectives" c
     LEFT JOIN "Users" u
     ON c."id" = u."CollectiveId"
     WHERE c."type" = 'USER' AND c."isIncognito" IS FALSE AND c."deletedAt" IS NULL
     AND (u."deletedAt" IS NOT NULL OR u."id" IS NULL)
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    // Not fixable
    throw new Error(message);
  }
}

/**
 * Each user must have at most one incognito USER collective linked via an ADMIN membership
 * from their main profile (same relationship as Collective.getIncognitoProfile).
 * Duplicates are merged into the lowest collective id using mergeAccounts.
 */
export async function checkAtMostOneIncognitoProfilePerUser({ fix }: { fix: boolean }) {
  const message =
    'Users with more than one incognito profile linked via ADMIN membership (run checks with --fix to merge duplicates)';

  const violatingUsers = await sequelize.query<{
    userId: number;
    nbIncognitoProfiles: number;
    incognitoProfilesIds: number[];
  }>(
    `
    SELECT u."id" AS "userId", COUNT(DISTINCT ic."id") AS "nbIncognitoProfiles", ARRAY_AGG(DISTINCT ic."id" ORDER BY ic."id") AS "incognitoProfilesIds"
    FROM "Users" u
    INNER JOIN "Members" m ON m."MemberCollectiveId" = u."CollectiveId"
      AND m."deletedAt" IS NULL
      AND m."role" = 'ADMIN'
    INNER JOIN "Collectives" ic ON ic."id" = m."CollectiveId"
      AND ic."deletedAt" IS NULL
      AND ic."type" = 'USER'
      AND ic."isIncognito" IS TRUE
    WHERE u."deletedAt" IS NULL
    GROUP BY u."id"
    HAVING COUNT(DISTINCT ic."id") > 1
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (violatingUsers.length === 0) {
    return;
  }

  if (!fix) {
    throw new Error(`${message}: ${violatingUsers.length} user(s)`);
  }

  logger.warn(`Fixing: ${message} (${violatingUsers.length} user(s))`);

  for (const { userId, incognitoProfilesIds } of violatingUsers) {
    const [keepId, ...mergeFromIds] = incognitoProfilesIds;
    const into = await models.Collective.findByPk(keepId);
    if (!into) {
      throw new Error(`checkAtMostOneIncognitoProfilePerUser: missing incognito collective ${keepId}`);
    }

    for (const fromId of mergeFromIds) {
      const from = await models.Collective.findByPk(fromId);
      if (!from) {
        continue;
      }
      await mergeAccounts(from, into, userId);
    }
  }
}

export const checks = [checkDeletedCollectives, checkDeletedUsers, checkAtMostOneIncognitoProfilePerUser];

if (!module.parent) {
  runAllChecksThenExit(checks);
}
