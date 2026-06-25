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
          (c."deactivatedAt" IS NOT NULL
            AND (a."createdAt" AT TIME ZONE 'UTC')::date >= (c."deactivatedAt" AT TIME ZONE 'UTC')::date) AS "isArchived",
          CASE
            WHEN a.type = 'collective.approved' THEN 'JOINED'
            WHEN a.type IN ('collective.unhosted', 'collective.archived') THEN 'CHURNED'
          END AS "event",
          a.id AS "activityId"
        FROM "Activities" a
          INNER JOIN "Collectives" c ON c.id = a."CollectiveId"
        WHERE
          a.type IN ('collective.approved', 'collective.unhosted', 'collective.archived')
          AND a."HostCollectiveId" IS NOT NULL
          AND a."CollectiveId" IS NOT NULL
          AND a."CollectiveId" != a."HostCollectiveId"
          AND c."ParentCollectiveId" IS NULL
          AND c."deletedAt" IS NULL
      );
    `);

    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "HostedCollectivesHostingPeriods";`);
    await queryInterface.sequelize.query(`
      CREATE VIEW "HostedCollectivesHostingPeriods" AS

      -- Currently hosted: open-ended interval from approvedAt onward (NULL endDate).
      SELECT
        c.id AS "CollectiveId",
        c."HostCollectiveId",
        c."ParentCollectiveId",
        c.type AS "collectiveType",
        (c."approvedAt" AT TIME ZONE 'UTC')::date AS "startDate",
        NULL::date AS "endDate"
      FROM "Collectives" c
      WHERE c."HostCollectiveId" IS NOT NULL
        AND c."approvedAt" IS NOT NULL
        AND c."ParentCollectiveId" IS NULL
        AND c.id != c."HostCollectiveId"
        AND c."deletedAt" IS NULL

      UNION ALL

      -- Past hosting: one closed interval per collective.unhosted or collective.archived Activity event.
      SELECT
        a."CollectiveId",
        a."HostCollectiveId",
        c."ParentCollectiveId",
        c.type AS "collectiveType",
        COALESCE(
          (SELECT (MIN(ha."createdAt") AT TIME ZONE 'UTC')::date
           FROM "HostApplications" ha
           WHERE ha."CollectiveId" = a."CollectiveId"
             AND ha."HostCollectiveId" = a."HostCollectiveId"
             AND ha.status = 'APPROVED'
             AND ha."createdAt" < a."createdAt"),
          (a."createdAt" AT TIME ZONE 'UTC')::date
        ) AS "startDate",
        (a."createdAt" AT TIME ZONE 'UTC')::date AS "endDate"
      FROM "Activities" a
      INNER JOIN "Collectives" c ON c.id = a."CollectiveId"
      WHERE a.type IN ('collective.unhosted', 'collective.archived')
        AND a."HostCollectiveId" IS NOT NULL
        AND a."CollectiveId" IS NOT NULL
        AND c."ParentCollectiveId" IS NULL
        AND a."CollectiveId" != a."HostCollectiveId"
        AND c."deletedAt" IS NULL
        -- Skip if currently re-hosted by the same host with an approval after this unhost/archive
        AND NOT (
          c."HostCollectiveId" IS NOT DISTINCT FROM a."HostCollectiveId"
          AND COALESCE(c."approvedAt" > a."createdAt", FALSE)
        );
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "HostedCollectivesDailyMembership";`);
    await queryInterface.sequelize.query(`
      CREATE VIEW "HostedCollectivesDailyMembership" AS (
        SELECT
          (a."createdAt" AT TIME ZONE 'UTC')::date AS "day",
          a."HostCollectiveId",
          a."CollectiveId",
          c.type AS "collectiveType",
          (c."deactivatedAt" IS NOT NULL
            AND (a."createdAt" AT TIME ZONE 'UTC')::date >= (c."deactivatedAt" AT TIME ZONE 'UTC')::date) AS "isArchived",
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
          AND c."deletedAt" IS NULL
      );
    `);

    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "HostedCollectivesHostingPeriods";`);
    await queryInterface.sequelize.query(`
      CREATE VIEW "HostedCollectivesHostingPeriods" AS

      SELECT
        c.id AS "CollectiveId",
        c."HostCollectiveId",
        c."ParentCollectiveId",
        c.type AS "collectiveType",
        (c."approvedAt" AT TIME ZONE 'UTC')::date AS "startDate",
        NULL::date AS "endDate"
      FROM "Collectives" c
      WHERE c."HostCollectiveId" IS NOT NULL
        AND c."approvedAt" IS NOT NULL
        AND c."ParentCollectiveId" IS NULL
        AND c.id != c."HostCollectiveId"
        AND c."deletedAt" IS NULL

      UNION ALL

      SELECT
        a."CollectiveId",
        a."HostCollectiveId",
        c."ParentCollectiveId",
        c.type AS "collectiveType",
        COALESCE(
          (SELECT (MIN(ha."createdAt") AT TIME ZONE 'UTC')::date
           FROM "HostApplications" ha
           WHERE ha."CollectiveId" = a."CollectiveId"
             AND ha."HostCollectiveId" = a."HostCollectiveId"
             AND ha.status = 'APPROVED'
             AND ha."createdAt" < a."createdAt"),
          (a."createdAt" AT TIME ZONE 'UTC')::date
        ) AS "startDate",
        (a."createdAt" AT TIME ZONE 'UTC')::date AS "endDate"
      FROM "Activities" a
      INNER JOIN "Collectives" c ON c.id = a."CollectiveId"
      WHERE a.type = 'collective.unhosted'
        AND a."HostCollectiveId" IS NOT NULL
        AND a."CollectiveId" IS NOT NULL
        AND c."ParentCollectiveId" IS NULL
        AND a."CollectiveId" != a."HostCollectiveId"
        AND c."deletedAt" IS NULL
        AND NOT (
          c."HostCollectiveId" IS NOT DISTINCT FROM a."HostCollectiveId"
          AND COALESCE(c."approvedAt" > a."createdAt", FALSE)
        );
    `);
  },
};
