'use strict';

module.exports = {
  up: async queryInterface => {
    // Host Unsorted
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__host_collective_id"
      ON "Transactions"("HostCollectiveId")
      WHERE "deletedAt" IS NULL AND "HostCollectiveId" IS NOT NULL
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transaction__host_collective_id"
    `);

    // Collective Unsorted
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__collective_id"
      ON "Transactions"("CollectiveId")
      WHERE "deletedAt" IS NULL AND "CollectiveId" IS NOT NULL
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "Transactions_GroupId"
    `);
    // Collective Sorted
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__collective_id_createdAt"
      ON "Transactions"("CollectiveId", ROUND(EXTRACT(epoch FROM "createdAt" AT TIME ZONE 'UTC') / 10) DESC)
      WHERE "deletedAt" IS NULL AND "CollectiveId" IS NOT NULL
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__collective_id_sorted"
    `);
  },

  down: async queryInterface => {
    // Host Unsorted
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transaction__host_collective_id"
      ON "Transactions"("HostCollectiveId")
      WHERE "deletedAt" IS NULL
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__host_collective_id"
    `);

    // Collective Unsorted
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "Transactions_GroupId"
      ON "Transactions"("CollectiveId", "deletedAt")
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__collective_id"
    `);
    // Collective Sorted
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__collective_id_sorted"
      ON "Transactions"("CollectiveId", "id")
      WHERE "deletedAt" IS NULL
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__collective_id_createdAt"
    `);
  },
};
