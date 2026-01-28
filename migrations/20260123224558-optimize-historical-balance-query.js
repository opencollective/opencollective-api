'use strict';

/**
 * Add index on TransactionBalances to optimize historical balance queries (dateTo).
 * This allows efficient lookup of the running balance at any point in time.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Add index for efficient historical balance lookups
    // The query pattern is: find the transaction with max rank where createdAt < endDate for each collective
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transaction_balances__collective_id_created_at"
      ON "TransactionBalances"("CollectiveId", "createdAt" DESC)
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transaction_balances__collective_id_created_at"
    `);
  },
};
