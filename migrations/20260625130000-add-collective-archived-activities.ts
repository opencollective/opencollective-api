'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      WITH archived_without_activity AS (
        SELECT c.id, c."deactivatedAt"
        FROM "Collectives" c
        LEFT OUTER JOIN "Activities" a ON c.id = a."CollectiveId" AND a.type = 'collective.archived'
        WHERE c."deactivatedAt" IS NOT NULL
          AND c."deletedAt" IS NULL
          AND a.id IS NULL
      ),
      with_host AS (
        SELECT
          a.id,
          a."deactivatedAt",
          (
            SELECT ah."HostCollectiveId"
            FROM "Activities" ah
            WHERE ah."CollectiveId" = a.id
              AND ah.type = 'collective.approved'
              AND ah."HostCollectiveId" IS NOT NULL
              AND ah."createdAt" <= a."deactivatedAt"
            ORDER BY ah."createdAt" DESC
            LIMIT 1
          ) AS "HostCollectiveId"
        FROM archived_without_activity a
      )
      INSERT INTO "Activities" ("type", "CollectiveId", "HostCollectiveId", "createdAt", "data")
      SELECT
        'collective.archived',
        w.id,
        w."HostCollectiveId",
        w."deactivatedAt",
        '{"notify": false, "createdFromMigration": true}'::jsonb
      FROM with_host w
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
