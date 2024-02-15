'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "expenses__collective_id_status"
      ON "Expenses"("CollectiveId", "status")
      WHERE "deletedAt" IS NULL
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "collectives__host_collective_id_approved"
      ON "Collectives"("HostCollectiveId")
      WHERE "HostCollectiveId" IS NOT NULL AND "deletedAt" IS NULL AND "approvedAt" IS NOT NULL
    `);

    // Related to security check and findRelatedUsersByConnectedAccounts
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "connected_accounts__service_username"
      ON "ConnectedAccounts"("service", "username")
      WHERE "deletedAt" IS NULL
    `);

    // Related to security check and PayoutMethod.findSimilar
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "payout_methods__account_number"
      ON "PayoutMethods" USING BTREE ((data#>>'{details,accountNumber}'))
      WHERE data#>>'{details,accountNumber}' IS NOT NULL AND "deletedAt" IS NULL
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "payout_methods__account_number"
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "connected_accounts__username"
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "collectives__host_collective_id_approved"
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "expenses__collective_id_status"
    `);
  },
};
