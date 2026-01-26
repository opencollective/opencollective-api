'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__contributions_date"
        ON "Transactions" (COALESCE("clearedAt", "createdAt"))
        INCLUDE ("OrderId", "HostCollectiveId")
        WHERE 
          "kind" IN ('CONTRIBUTION', 'ADDED_FUNDS') AND
          type = 'CREDIT' AND
          "isRefund" = false AND "RefundTransactionId" IS NULL AND "deletedAt" IS NULL;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__contributions_host_id"
      ON "Transactions" ("HostCollectiveId", COALESCE("clearedAt", "createdAt"))
      INCLUDE ("OrderId")
      WHERE 
        "kind" IN ('CONTRIBUTION', 'ADDED_FUNDS') AND
        type = 'CREDIT' AND
        "isRefund" = false AND "RefundTransactionId" IS NULL and "deletedAt" IS NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transactions__contributions_date";
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transactions__contributions_host_id";
    `);
  },
};
