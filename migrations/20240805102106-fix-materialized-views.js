'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "collective_transaction_stats__id" ON "CollectiveTransactionStats" (id);`,
    );
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "collective_order_stats__collective_id" ON "CollectiveOrderStats" ("CollectiveId");`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "collective_transaction_stats__id";
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "collective_order_stats__collective_id";
    `);
  },
};
