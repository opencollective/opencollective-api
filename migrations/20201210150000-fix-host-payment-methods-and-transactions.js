'use strict';

module.exports = {
  up: async queryInterface => {
    const [, updateTs] = await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "amountInHostCurrency" = "amount", "hostFeeInHostCurrency" = ROUND("hostFeeInHostCurrency"/"hostCurrencyFxRate"), "hostCurrencyFxRate" = 1
      FROM "PaymentMethods" pm, "Collectives" c
      WHERE
        "Transactions"."currency" = "Transactions"."hostCurrency"
        AND "Transactions"."hostCurrencyFxRate" != 1
        AND pm.id = "Transactions"."PaymentMethodId"
        AND c.id = pm."CollectiveId"
        AND pm."type" = 'host'
        AND pm."currency" != "Transactions"."currency"
    `);

    console.info(`Fixed ${updateTs.rowCount} transactions`);
  },

  down: async () => {
    // No rollback
  },
};
