'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__collective_id_created_at_regular"
      ON "Transactions"("CollectiveId", "createdAt" DESC)
      WHERE "deletedAt" IS NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__collective_id_created_at_regular"
    `);
  },
};
