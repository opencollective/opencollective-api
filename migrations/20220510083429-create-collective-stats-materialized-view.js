'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW "CollectiveStats" AS
      SELECT
        c.id,
        (
          SELECT COUNT(t.id)
          FROM "Transactions" t
          WHERE t."CollectiveId" = c.id
          AND t."deletedAt" IS NULL
        ) AS "transactionsCount",
        (
          CASE WHEN c."isHostAccount" IS TRUE THEN (
            SELECT COUNT(id)
            FROM "Collectives" hc
            WHERE hc."HostCollectiveId" = c.id
            AND hc."isActive" IS TRUE
            AND hc."deletedAt" IS NULL
            AND hc."type" = 'COLLECTIVE'
          ) ELSE
            0
          END
        ) AS "hostedCollectivesCount"
        FROM "Collectives" c
        WHERE c."deletedAt" IS NULL
        AND c."deactivatedAt" IS NULL
        AND (c."data" ->> 'isGuest')::boolean IS NOT TRUE
        AND c.name != 'incognito'
        AND c.name != 'anonymous'
        AND c."isIncognito" = FALSE
    `);

    // Add a unique index on collective ID to the materialized view
    await queryInterface.sequelize.query(`CREATE UNIQUE INDEX ON "CollectiveStats"(id)`);
  },

  async down(queryInterface) {
    // Remember to remove `cron/hourly/50-refresh-collective-stats-materialized-view.js` if you get rid of this view
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW "CollectiveStats"`);
  },
};
