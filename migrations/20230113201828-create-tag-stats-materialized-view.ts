'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS "CollectiveTagStats" AS
    SELECT DISTINCT unnest(tags) AS tag, COUNT(*) AS count FROM "Collectives" GROUP BY tag ORDER BY count DESC
  `);
  },

  async down(queryInterface) {
    // Remember to remove `cron/daily/91-refresh-collective-tag-stats-materialized-view.ts` if you get rid of this view
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW "CollectiveTagStats"`);
  },
};
