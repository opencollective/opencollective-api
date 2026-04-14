'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS  "Transactions_HostCollectiveId_Contributions"
        on "Transactions"("HostCollectiveId", coalesce("clearedAt", "createdAt"))
        include ("OrderId", "CollectiveId", "FromCollectiveId", "createdAt", "clearedAt", "amountInHostCurrency", "currency")
        where (not "isRefund") and "RefundTransactionId" is null and "type" = 'CREDIT' and ("deletedAt" is null) and "kind" in ('CONTRIBUTION', 'ADDED_FUNDS');
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS  "Transactions_HostCollectiveId_Contributions";
    `);
  },
};
