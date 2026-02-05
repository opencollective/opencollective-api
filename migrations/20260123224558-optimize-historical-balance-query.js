'use strict';

/**
 * Add index on TransactionBalances to optimize historical balance queries.
 * The query uses DISTINCT ON (CollectiveId) ORDER BY CollectiveId, rank DESC
 * to find the most recent balance for each collective.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Add index for efficient historical balance lookups
    // The query orders by rank DESC (not createdAt) for deterministic results
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transaction_balances__collective_id_rank"
      ON "TransactionBalances"("CollectiveId", "rank" DESC)
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transaction_balances__collective_id_rank"
    `);
  },
};
