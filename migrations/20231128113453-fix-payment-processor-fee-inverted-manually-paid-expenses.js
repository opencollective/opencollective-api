'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      BEGIN;

      WITH transactions_to_update AS (
      SELECT *
      FROM "Transactions" t
      WHERE t."type" = 'DEBIT'
      AND t."kind" = 'EXPENSE'
      AND t."isRefund" IS FALSE
      AND t."deletedAt" IS NULL
      AND t."paymentProcessorFeeInHostCurrency" < 0
      AND (t."amountInHostCurrency" = 0 OR t."netAmountInCollectiveCurrency" = 0)
      ), updated_debits AS (
      -- Update DEBIT transactions
      UPDATE "Transactions" t
      SET
        "amount" = t."netAmountInCollectiveCurrency",
        "amountInHostCurrency" = t."paymentProcessorFeeInHostCurrency",
        "paymentProcessorFeeInHostCurrency" = 0,
        "data" = jsonb_set(t.data, '{valuesBeforeMigration20231128113453}', jsonb_build_object('type', t."type", 'amount', t."amount", 'amountInHostCurrency', t."amountInHostCurrency", 'paymentProcessorFeeInHostCurrency', t."paymentProcessorFeeInHostCurrency", 'netAmountInCollectiveCurrency', t."netAmountInCollectiveCurrency"))
      FROM transactions_to_update tu
      WHERE tu.id = t.id
      AND t."amountInHostCurrency" = 0 -- Both transactions were created as DEBIT, but we're picking these ones because they have their "HostCollectiveId" correctly set
      RETURNING t.*
      ), updated_credits AS (
      UPDATE "Transactions" t
      SET
        "type" = 'CREDIT',
        "paymentProcessorFeeInHostCurrency" = 0,
        "netAmountInCollectiveCurrency" = t."amount",
        "data" = jsonb_set(t.data, '{valuesBeforeMigration20231128113453}', jsonb_build_object('type', t."type", 'amount', t."amount", 'amountInHostCurrency', t."amountInHostCurrency", 'paymentProcessorFeeInHostCurrency', t."paymentProcessorFeeInHostCurrency", 'netAmountInCollectiveCurrency', t."netAmountInCollectiveCurrency"))
      FROM transactions_to_update tu
      WHERE tu.id = t.id
      AND t."netAmountInCollectiveCurrency" = 0 -- Both transactions were created as DEBIT, but we're picking these ones because they have their "HostCollectiveId" correctly set
      RETURNING t.*
      ) SELECT * FROM updated_debits
      UNION ALL SELECT * FROM updated_credits;
      
      COMMIT;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET
        "type" = data -> 'valuesBeforeMigration20231128113453' ->> 'type',
        "amount" = (data -> 'valuesBeforeMigration20231128113453' ->> 'amount')::numeric,
        "amountInHostCurrency" = (data -> 'valuesBeforeMigration20231128113453' ->> 'amountInHostCurrency')::numeric,
        "paymentProcessorFeeInHostCurrency" = (data -> 'valuesBeforeMigration20231128113453' ->> 'paymentProcessorFeeInHostCurrency')::numeric,
        "netAmountInCollectiveCurrency" = (data -> 'valuesBeforeMigration20231128113453' ->> 'netAmountInCollectiveCurrency')::numeric,
        "data" = jsonb_set(data, '{valuesBeforeMigration20231128113453}', NULL)
      WHERE data -> 'valuesBeforeMigration20231128113453' IS NOT NULL;
    `);
  },
};
