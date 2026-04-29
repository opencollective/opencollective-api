'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "HostedCollectivesDailyMembership";`);
    await queryInterface.sequelize.query(`
      CREATE VIEW "HostedCollectivesDailyMembership" AS (
        SELECT
          (a."createdAt" AT TIME ZONE 'UTC')::date AS "day",
          a."HostCollectiveId",
          a."CollectiveId",
          c.type AS "collectiveType",
          CASE
            WHEN a.type = 'collective.approved' THEN 'JOINED'
            WHEN a.type = 'collective.unhosted' THEN 'CHURNED'
          END AS "event",
          a.id AS "activityId"
        FROM "Activities" a
          INNER JOIN "Collectives" c ON c.id = a."CollectiveId"
        WHERE
          a.type IN ('collective.approved', 'collective.unhosted')
          AND a."HostCollectiveId" IS NOT NULL
          AND a."CollectiveId" IS NOT NULL
          AND a."CollectiveId" != a."HostCollectiveId"
          AND c."ParentCollectiveId" IS NULL
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "HostedCollectivesDailyMembership";`);
  },
};
