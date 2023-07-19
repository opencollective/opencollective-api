'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transaction_host_collective_id"
      ON "Transactions"("HostCollectiveId")
      WHERE "deletedAt" IS NULL
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transaction_host_collective_id";
    `);
  },
};
