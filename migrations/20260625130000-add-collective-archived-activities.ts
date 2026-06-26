'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      WITH archived_collectives AS (
        SELECT
          c.id,
          c."deactivatedAt",
          -- Infer host from closest approved activity
          (
            SELECT a."HostCollectiveId"
            FROM "Activities" a
            WHERE a."CollectiveId" = COALESCE(c."ParentCollectiveId", c.id)
              AND a.type = 'collective.approved'
              AND a."HostCollectiveId" IS NOT NULL
              AND a."CollectiveId" != a."HostCollectiveId"
              AND a."createdAt" <= c."deactivatedAt"
              AND NOT EXISTS (
                SELECT 1
                FROM "Activities" u
                WHERE u."CollectiveId" = COALESCE(c."ParentCollectiveId", c.id)
                  AND u."HostCollectiveId" = a."HostCollectiveId"
                  AND u.type = 'collective.unhosted'
                  AND u."createdAt" > a."createdAt"
                  AND u."createdAt" <= c."deactivatedAt"
            )
            ORDER BY a."createdAt" DESC
            LIMIT 1
          ) AS "HostCollectiveId"
        FROM "Collectives" c
        WHERE c."deactivatedAt" IS NOT NULL
          AND c."deletedAt" IS NULL
      ) INSERT INTO "Activities" ("type", "CollectiveId", "HostCollectiveId", "createdAt", "data")
      SELECT
        'collective.archived',
        c.id,
        c."HostCollectiveId",
        c."deactivatedAt",
        '{"notify": false, "createdFromMigration": true}'::jsonb
      FROM archived_collectives c
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM "Activities"
      WHERE type = 'collective.archived'
        AND data->>'createdFromMigration' = 'true'
    `);
  },
};
