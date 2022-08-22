'use strict';

module.exports = {
  up: async queryInterface => {
    // Fix Payment Methods currency not matching the Host currency
    await queryInterface.sequelize.query(`
      UPDATE "PaymentMethods" as pm
      SET "currency" = h."currency"
      FROM "Collectives" as c, "Collectives" as h
      WHERE c."id" = pm."CollectiveId"
      AND pm."service" = 'opencollective'
      AND pm."type" = 'collective'
      AND pm."deletedAt" IS NULL
      AND c."deletedAt" IS NULL
      AND h."id" = c."HostCollectiveId"
      AND pm."currency" !=  h."currency"
    `);
    // Fix some transactions impacted by this
    // easy cases where t."currency" = t."hostCurrency"
    await queryInterface.sequelize.query(`
      UPDATE "Transactions" as t
      SET "hostCurrencyFxRate" = 1, "amountInHostCurrency" = "amount", "netAmountInCollectiveCurrency" = "amount"
      FROM "PaymentMethods" as pm
      WHERE pm."id" = t."PaymentMethodId"
      AND pm."service" = 'opencollective'
      AND pm."type" = 'collective'
      AND t."currency" = t."hostCurrency"
      AND t."hostCurrencyFxRate" != 1
      AND t."platformFeeInHostCurrency" = 0
      AND t."hostFeeInHostCurrency" = 0
      AND t."paymentProcessorFeeInHostCurrency" = 0;
    `);
  },

  down: async () => {
    // No rollback
  },
};
