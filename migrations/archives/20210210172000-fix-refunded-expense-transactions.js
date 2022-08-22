'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions" t SET "ExpenseId" = r."ExpenseId"
      FROM "Transactions" r
      WHERE
        t."RefundTransactionId" IS NOT NULL
        AND t."isRefund" IS TRUE
        AND t."RefundTransactionId" = r."id"
        AND t."ExpenseId" IS NULL
        AND r."ExpenseId" IS NOT NULL;
    `);
  },

  down: async () => {
    // No rollback
  },
};
