'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions" fee_cover
      SET "ExpenseId" = refund."ExpenseId"
      FROM "Transactions" AS refund
      WHERE refund."TransactionGroup" = fee_cover."TransactionGroup"
      AND fee_cover.kind = 'PAYMENT_PROCESSOR_COVER'
      AND fee_cover."isRefund" = TRUE
      AND fee_cover."ExpenseId" IS NULL
      AND refund."isRefund" = TRUE
      AND refund."ExpenseId" IS NOT NULL
  `);
  },

  down: async queryInterface => {
    // ExpenseId was never recorded for kind=PAYMENT_PROCESSOR_COVER, so we can safely remove it
    await queryInterface.sequelize.query(`
      UPDATE "Transactions" fee_cover
      SET "ExpenseId" = NULL
      WHERE t.kind = 'PAYMENT_PROCESSOR_COVER'
      AND t."ExpenseId" IS NOT NULL
    `);
  },
};
