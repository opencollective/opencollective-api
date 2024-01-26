'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__host_collective_id_createdAt"
      ON "Transactions"("HostCollectiveId", ROUND(EXTRACT(epoch FROM "createdAt" AT TIME ZONE 'UTC') / 10) DESC)
      WHERE "deletedAt" IS NULL AND "HostCollectiveId" IS NOT NULL
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transactions__host_collective_id_createdAt"
    `);
  },
};
