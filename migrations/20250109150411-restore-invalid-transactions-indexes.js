'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // transactions__collective_id_createdAt
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transactions__collective_id_createdAt"
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY "transactions__collective_id_createdAt"
      ON "Transactions"("CollectiveId", ROUND(EXTRACT(epoch FROM "createdAt" AT TIME ZONE 'UTC') / 10) DESC)
      WHERE "deletedAt" IS NULL
    `);

    // transactions__host_collective_id_createdAt
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transactions__host_collective_id_createdAt"
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY "transactions__host_collective_id_createdAt"
      ON "Transactions"("HostCollectiveId", ROUND(EXTRACT(epoch FROM "createdAt" AT TIME ZONE 'UTC') / 10) DESC)
      WHERE "deletedAt" IS NULL AND "HostCollectiveId" IS NOT NULL
    `);
  },

  async down(queryInterface, Sequelize) {
    console.log('This migration cannot be reverted');
  },
};
