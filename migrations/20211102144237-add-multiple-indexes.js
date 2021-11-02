'use strict';

module.exports = {
  up: async queryInterface => {
    // Some indexes for transactions
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY "transactions_kind"
      ON "Transactions"("kind")
      WHERE "deletedAt" IS NULL
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY "transactions_expense_id"
      ON "Transactions"("ExpenseId")
      WHERE "deletedAt" IS NULL
      AND "ExpenseId" IS NOT NULL
    `);

    // Some indexes for orders
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY "orders_from_collective_id"
      ON "Orders"("FromCollectiveId")
      WHERE "deletedAt" IS NULL
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY "orders_collective_id"
      ON "Orders"("CollectiveId")
      WHERE "deletedAt" IS NULL
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY "orders_tier_id"
      ON "Orders"("TierId")
      WHERE "deletedAt" IS NULL
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY "orders_status"
      ON "Orders"("status")
      WHERE "deletedAt" IS NULL
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "transactions_kind"`);
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "transactions_expense_id"`);
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "orders_from_collective_id"`);
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "orders_collective_id"`);
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "orders_tier_id"`);
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "orders_status"`);
  },
};
