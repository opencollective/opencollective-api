'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const [, debitResult] = await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "amountInHostCurrency" = "netAmountInCollectiveCurrency"
      WHERE "OrderId" IS NOT NULL
      AND "hostCurrencyFxRate" != 1
      AND "data"->>'isFeesOnTop' = 'true'
      AND "type" = 'DEBIT'
      AND ("CollectiveId" = 1 OR "FromCollectiveId" = 1);
    `);

    console.info(`Updated ${debitResult.rowCount} DEBIT transactions`);

    // FX Rate
    const [, fxResult] = await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "hostCurrencyFxRate" = 1
      WHERE "OrderId" IS NOT NULL
      AND "hostCurrencyFxRate" != 1
      AND "data"->>'isFeesOnTop' = 'true'
      AND ("CollectiveId" = 1 OR "FromCollectiveId" = 1);
    `);

    console.info(`Updated ${fxResult.rowCount} FXRate transactions`);
  },

  down: async () => {
    /**
     * They'd be a risk of corrupting other data if we allow rollback on this one.
     */
  },
};
