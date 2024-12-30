'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY "CurrentCollectiveTransactionStatsIndex"
      ON "Transactions" ("CollectiveId", "createdAt")
      WHERE "deletedAt" IS NULL
      AND "RefundTransactionId" IS NULL
      AND ("isRefund" IS NOT TRUE OR "kind" = 'PAYMENT_PROCESSOR_COVER')
      AND "isInternal" IS NOT TRUE
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY "CurrentCollectiveTransactionStatsIndex"
    `);
  },
};
