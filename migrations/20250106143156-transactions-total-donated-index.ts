'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions_total_donated"
      ON "Transactions" ("OrderId")
      WHERE "deletedAt" IS NULL
        AND "RefundTransactionId" IS NULL
        AND "type" = 'CREDIT'
        AND "kind" IN ('CONTRIBUTION', 'ADDED_FUNDS')
        AND "deletedAt" IS NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transactions_total_donated"
    `);
  },
};
