'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      WITH collectives_without_create_activity AS (
        SELECT c.id, c."createdAt", c."ParentCollectiveId", c."HostCollectiveId", c."CreatedByUserId"
        FROM "Collectives" c
        LEFT OUTER JOIN "Activities" a on c.id = a."CollectiveId" AND a.type = 'COLLECTIVE_CREATED'
        WHERE c."deletedAt" IS NULL
        AND c.type != 'ORGANIZATION' -- Orgs have their own create event
        AND c.type != 'USER'
      ) INSERT INTO "Activities" ("type", "CollectiveId", "HostCollectiveId", "UserId", "createdAt", "data")
      SELECT 'collective.created', c.id, c."HostCollectiveId", c."CreatedByUserId", c."createdAt", '{"createdFromMigration": true}'
      FROM collectives_without_create_activity c
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM "Activities"
      WHERE type = 'collective.created'
      AND data->>'createdFromMigration' = 'true'
    `);
  },
};
