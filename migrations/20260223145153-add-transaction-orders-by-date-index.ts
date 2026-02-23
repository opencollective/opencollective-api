'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "Transactions_Orders_by_date"
      ON "Transactions" (COALESCE("clearedAt", "createdAt")) INCLUDE ("OrderId", "isDebt", "isRefund", kind, "CollectiveId", "HostCollectiveId", "FromCollectiveId") WHERE (kind = ANY (ARRAY['CONTRIBUTION'::"enum_Transactions_kind", 'ADDED_FUNDS'::"enum_Transactions_kind"])) AND "deletedAt" IS NULL AND type::text = 'CREDIT'::text
    `);

    // "Transactions_Orders_by_date" btree (COALESCE("clearedAt", "createdAt")) INCLUDE ("OrderId", "isDebt", "isRefund", kind, "CollectiveId", "HostCollectiveId", "FromCollectiveId") WHERE (kind = ANY (ARRAY['CONTRIBUTION'::"enum_Transactions_kind", 'ADDED_FUNDS'::"enum_Transactions_kind"])) AND "deletedAt" IS NULL AND type::text = 'CREDIT'::text
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "Transactions_Orders_by_date";
    `);
  },
};
