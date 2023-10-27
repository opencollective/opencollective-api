'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS "ExpenseTagStats" AS
      SELECT "tag", "count", "HostCollectiveId", null::integer AS "CollectiveId"
      FROM (
          SELECT unnest("Expenses".tags) AS "tag", COUNT(*) AS "count", "Collectives"."HostCollectiveId"
          FROM "Expenses"
          JOIN "Collectives" ON "Expenses"."CollectiveId" = "Collectives"."id"
              AND "Collectives"."approvedAt" IS NOT NULL
          WHERE "Collectives"."HostCollectiveId" IS NOT NULL
          AND "Expenses"."deletedAt" IS NULL
          AND "Expenses"."status" NOT IN ('SPAM', 'DRAFT', 'UNVERIFIED')
          GROUP BY "tag", "Collectives"."HostCollectiveId"
      ) AS HostTags
      UNION 
      SELECT "tag", "count", null::integer AS "HostCollectiveId", "CollectiveId"
      FROM (
          SELECT unnest(tags) AS "tag", COUNT(*) AS "count", "CollectiveId"
          FROM "Expenses"
          WHERE "CollectiveId" IS NOT NULL
          AND "deletedAt" IS NULL
          AND "status" NOT IN ('SPAM', 'DRAFT', 'UNVERIFIED')
          GROUP BY "tag", "CollectiveId"
      ) AS CollectiveTags;`);

    // A unique index is needed to allow concurrently refreshing the materialized view
    await queryInterface.addIndex('ExpenseTagStats', ['HostCollectiveId', 'CollectiveId', 'tag'], {
      unique: true,
      concurrently: true,
    });
    await queryInterface.addIndex('ExpenseTagStats', ['HostCollectiveId'], { concurrently: true });
    await queryInterface.addIndex('ExpenseTagStats', ['CollectiveId'], { concurrently: true });
    await queryInterface.addIndex('ExpenseTagStats', ['tag'], { concurrently: true });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('ExpenseTagStats', ['HostCollectiveId', 'CollectiveId', 'tag']);
    await queryInterface.removeIndex('ExpenseTagStats', ['HostCollectiveId']);
    await queryInterface.removeIndex('ExpenseTagStats', ['CollectiveId']);
    await queryInterface.removeIndex('ExpenseTagStats', ['tag']);

    // Remember to remove from  `cron/hourly/50-refresh-materialized-views.js` if you get rid of this view
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW "ExpenseTagStats"`);
  },
};
