'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions_expenses_tags_index"
      ON "Transactions" ("CollectiveId")
      WHERE "deletedAt" IS NULL
      AND "RefundTransactionId" IS NULL
      AND "kind" = 'EXPENSE'
      AND "type" = 'DEBIT'
      AND "ExpenseId" IS NOT NULL
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transactions_expenses_tags_index"
    `);
  },
};
