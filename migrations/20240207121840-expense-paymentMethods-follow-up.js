'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Payment Method was not propagated to Transactions in previous migration
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "PaymentMethodId" = "Expenses"."PaymentMethodId"
      FROM "Expenses"
      WHERE "Transactions"."ExpenseId" = "Expenses"."id"
      AND "Transactions"."PaymentMethodId" IS NULL
      AND "Transactions"."kind" IN ('EXPENSE', 'PAYMENT_PROCESSOR_FEE')
      AND "Transactions"."deletedAt" IS NULL
      AND "Expenses"."PaymentMethodId" IS NOT NULL
    `);
  },

  async down() {},
};
