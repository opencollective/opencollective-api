'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__host_collective_id"
      ON "Transactions"("HostCollectiveId")
      WHERE "deletedAt" IS NULL AND "HostCollectiveId" IS NOT NULL
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX "transaction__host_collective_id"
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transaction__host_collective_id"
      ON "Transactions"("HostCollectiveId")
      WHERE "deletedAt" IS NULL
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX "transactions__host_collective_id"
    `);
  },
};
