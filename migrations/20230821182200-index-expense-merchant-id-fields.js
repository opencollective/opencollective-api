'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Stripe issued Virtual Card transactions
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "expenses_data_stripe_virtual_card_transaction_id"
      ON "Expenses"
      USING BTREE (("data"#>>'{transactionId}') ASC)
      WHERE "data"#>>'{transactionId}' IS NOT NULL
      AND "deletedAt" IS NULL
    `);

    // PayPal transactions
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "expenses_data_paypal_transaction_id"
      ON "Expenses"
      USING BTREE (("data"#>>'{transaction_id}') ASC)
      WHERE "data"#>>'{transaction_id}' IS NOT NULL
      AND "deletedAt" IS NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "expenses_data_transactionId";`);
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "expenses_data_transaction_id";`);
  },
};
