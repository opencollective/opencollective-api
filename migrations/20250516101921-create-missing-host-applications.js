'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Create missing host applications for collectives that are currently hosted
    await queryInterface.sequelize.query(`
      INSERT INTO
        "HostApplications" ("CollectiveId", "HostCollectiveId", status, message, "createdAt", "updatedAt", "customData")
      SELECT
        c.id AS "CollectiveId", c."HostCollectiveId" AS "HostCollectiveId", 'APPROVED' AS "status",
        'Automatically created by platform migration' AS "message", c."createdAt" AS "createdAt", NOW() AS "updatedAt", '{
        "migration": "20250516101921-create-missing-host-applications"
      }'::jsonb AS "customData"
      FROM
        "Collectives" c
        LEFT JOIN "HostApplications" a
        ON (c.id = a."CollectiveId" AND a.status = 'APPROVED' AND a."deletedAt" IS NULL)
      WHERE
        -- Hosted but not self-hosted
        c."HostCollectiveId" IS NOT NULL
        AND c."HostCollectiveId" != c."id"
        AND c."approvedAt" IS NOT NULL
        AND c."isActive" IS TRUE
        -- Is not a children collective
        AND c."ParentCollectiveId" IS NULL
        -- Is not deleted
        AND c."deletedAt" IS NULL
      GROUP BY
        c.id
      -- Has no approved host application
      HAVING COUNT(a.id) = 0
    `);

    // Create missing host applications for collectives that were once hosted
    await queryInterface.sequelize.query(`
      INSERT INTO
          "HostApplications" ("CollectiveId", "HostCollectiveId", status, message, "createdAt", "updatedAt", "customData")
      SELECT
        c.id AS "CollectiveId", ch."HostCollectiveId" AS "HostCollectiveId", 'APPROVED' AS "status",
        'Automatically created by platform migration' AS "message", MAX(ch."updatedAt") AS "createdAt", NOW() AS "updatedAt",
        '{
          "migration": "20250516101921-create-missing-host-applications"
        }'::jsonb AS "customData"
      FROM
        "Collectives" c
          -- Was previously hosted by another collective
        INNER JOIN "CollectiveHistories" ch
        ON c."id" = ch.id AND ch."HostCollectiveId" IS NOT NULL AND ch."HostCollectiveId" != c."HostCollectiveId"
          AND ch."approvedAt" IS NOT NULL
          AND ch."isActive" IS TRUE
        -- The host collective still exists
        INNER JOIN "Collectives" h
        ON (h.id = ch."HostCollectiveId" AND h."deletedAt" IS NULL)
        LEFT JOIN "HostApplications" a
        ON (c.id = a."CollectiveId" AND a."HostCollectiveId" = ch."HostCollectiveId" AND a.status = 'APPROVED' AND
            a."deletedAt" IS NULL)
      WHERE
        -- Is not a children collective
        c."ParentCollectiveId" IS NULL
        -- Is not deleted
        AND c."deletedAt" IS NULL
      GROUP BY
        c.id, ch."HostCollectiveId"
      -- Has no approved host application
      HAVING COUNT(a.id) = 0
    `);
  },

  async down(queryInterface) {
    // Delete host applications created by this migration
    await queryInterface.sequelize.query(`
      DELETE FROM "HostApplications"
      WHERE "customData"->>'migration' = '20250516101921-create-missing-host-applications';
    `);
  },
};
