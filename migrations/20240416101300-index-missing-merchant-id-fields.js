'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Based on Transaction.MERCHANT_ID_PATHS
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__data_capture_id"
      ON "Transactions"
      USING BTREE (("data"#>>'{capture,id}') ASC)
      WHERE "data"#>>'{capture,id}' IS NOT NULL
      AND "deletedAt" IS NULL
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__data_paypalSale_id"
      ON "Transactions"
      USING BTREE (("data"#>>'{paypalSale,id}') ASC)
      WHERE "data"#>>'{paypalSale,id}' IS NOT NULL
      AND "deletedAt" IS NULL
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__data_paypalResponse_id"
      ON "Transactions"
      USING BTREE (("data"#>>'{paypalResponse,id}') ASC)
      WHERE "data"#>>'{paypalResponse,id}' IS NOT NULL
      AND "deletedAt" IS NULL
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__data_transaction_id"
      ON "Transactions"
      USING BTREE (("data"#>>'{transaction,id}') ASC)
      WHERE "data"#>>'{transaction,id}' IS NOT NULL
      AND "deletedAt" IS NULL
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__data_transactionid"
      ON "Transactions"
      USING BTREE (("data"#>>'{transaction_id}') ASC)
      WHERE "data"#>>'{transaction_id}' IS NOT NULL
      AND "deletedAt" IS NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "transactions__data_capture_id";`);
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "transactions__data_paypalSale_id";`);
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "transactions__data_paypalResponse_id";`);
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "transactions__data_transaction_id";`);
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "transactions__data_transactionid";`);
  },
};
