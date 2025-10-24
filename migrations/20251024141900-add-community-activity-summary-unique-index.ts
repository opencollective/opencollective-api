'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "community_activity_summary__all_collective_ids"
      ON "CommunityActivitySummary"("HostCollectiveId", "FromCollectiveId", "CollectiveId");
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "community_activity_summary__all_collective_ids";  
    `);
  },
};
