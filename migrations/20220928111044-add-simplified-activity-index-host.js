'use strict';

module.exports = {
  async up(queryInterface) {
    // FromCollectiveId
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities__host_collective_id_simple"
      ON "Activities"("HostCollectiveId")
      WHERE "HostCollectiveId" IS NOT NULL
      AND "type" NOT IN ('collective.transaction.created')
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "activities__host_collective_id_simple";
    `);
  },
};
