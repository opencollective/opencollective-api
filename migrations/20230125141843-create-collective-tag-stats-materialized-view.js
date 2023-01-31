'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS "CollectiveTagStats" AS
      SELECT tag, count, null AS "HostCollectiveId"
      FROM (
        SELECT DISTINCT unnest(tags) AS tag, COUNT(*) AS count 
        FROM "Collectives"
        WHERE "deletedAt" IS NULL
        AND "isIncognito" IS NOT TRUE
        AND ("data" ->> 'isGuest')::boolean IS NOT TRUE 
        AND (COALESCE(("data"#>>'{spamReport,score}')::float, 0) <= 0.2 OR "createdAt" < (NOW() - interval '2 day'))
        AND (("data" ->> 'hideFromSearch'::text)::boolean) IS NOT TRUE
        GROUP BY tag
      ) AS AllTags
      UNION 
      SELECT tag, count, "HostCollectiveId"
      FROM (
        SELECT DISTINCT unnest(tags) AS tag, COUNT(*) AS count, "HostCollectiveId"
        FROM "Collectives"
        WHERE "HostCollectiveId" IS NOT NULL
        AND "deletedAt" IS NULL
        AND "isIncognito" IS NOT TRUE
        AND ("data" ->> 'isGuest')::boolean IS NOT TRUE 
        AND (COALESCE(("data"#>>'{spamReport,score}')::float, 0) <= 0.2 OR "createdAt" < (NOW() - interval '2 day'))
        AND (("data" ->> 'hideFromSearch'::text)::boolean) IS NOT TRUE
        GROUP BY tag, "HostCollectiveId"
      ) AS HostTags
      ORDER BY count DESC`);

    await queryInterface.sequelize.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS collective_tag_stats__HostCollectiveId ON "CollectiveTagStats"("HostCollectiveId")`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS collective_tag_stats__HostCollectiveId`);
    // Remember to remove `cron/daily/91-refresh-collective-tag-stats-materialized-view.ts` if you get rid of this view
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW "CollectiveTagStats"`);
  },
};
