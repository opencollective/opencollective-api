'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions" t
      SET "amountInHostCurrency" = t."amount" * t."hostCurrencyFxRate"
      FROM "Expenses" e
      WHERE t."ExpenseId" = e."id"
      AND t."type" = 'DEBIT'
      AND t."amount" != t."amountInHostCurrency"
      AND t."paymentProcessorFeeInHostCurrency" != 0
      AND t."isRefund" IS FALSE
      AND e."feesPayer" = 'PAYEE';
    `);
  },

  down: async () => {
    return;
  },
};
