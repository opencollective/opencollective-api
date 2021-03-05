'use strict';

module.exports = {
  up: async queryInterface => {
    // 1. Add the missing CONTRIBUTOR members (~1143 entries)
    await queryInterface.sequelize.query(`
      INSERT INTO "Members" (
        "CreatedByUserId", "MemberCollectiveId", "CollectiveId", "role", "since"
      ) SELECT
        u."id" AS "CreatedByUserId",
        u."CollectiveId" AS "MemberCollectiveId",
        e."CollectiveId" AS "CollectiveId",
        'CONTRIBUTOR' as "role",
        MIN(e."createdAt") AS "since"
      FROM
        "Expenses" e
      INNER JOIN "Collectives" from_collective
        ON e."FromCollectiveId" = from_collective.id
        AND from_collective."type" = 'USER'
      INNER JOIN "Users" u
        ON u."CollectiveId" = from_collective.id
      LEFT JOIN "Members" m
        ON m."MemberCollectiveId" = e."FromCollectiveId"
        AND m."CollectiveId" = e."CollectiveId"
        AND "role" = 'CONTRIBUTOR'
      WHERE
        e."deletedAt" IS NULL
        AND from_collective."deletedAt" IS NULL
        AND u."deletedAt" IS NULL
        AND e.status = 'PAID'
      GROUP BY
        e."CollectiveId",
        u."id"
      HAVING
        COUNT(m.id) = 0
    `);

    // 2. Remove duplicate members for role=CONTRIBUTOR (~20915 entries) - see https://github.com/opencollective/opencollective/issues/2753
    await queryInterface.sequelize.query(`
      WITH duplicate_members_to_remove AS (
        SELECT
          duplicate_members.id AS "id"
        FROM
          "Members" members,
          "Members" duplicate_members
        WHERE
          -- Always keep the oldest entry
          duplicate_members.id > members.id
          AND members."CollectiveId" = duplicate_members."CollectiveId"
          AND members."MemberCollectiveId" = duplicate_members."MemberCollectiveId"
          AND members."role" = duplicate_members."role"
          AND ((members."TierId" IS NULL AND duplicate_members."TierId" IS NULL) OR (members."TierId" = duplicate_members."TierId"))
          AND members."deletedAt" IS NULL AND duplicate_members."deletedAt" IS NULL
        GROUP BY duplicate_members.id
      ) UPDATE "Members" member
      SET
        "deletedAt" = NOW()
      FROM
        duplicate_members_to_remove
      WHERE
        member.id = duplicate_members_to_remove.id
    `);
  },

  down: async () => {
    /** Reverting should be done manually (using `createdAt`/`deletedAt`) */
  },
};
