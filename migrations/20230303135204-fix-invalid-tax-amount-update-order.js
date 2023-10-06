'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `
      WITH invalid_transactions AS (
        SELECT
          "TransactionGroup",
          -(amount - ROUND("amount"  / (1 + ((data -> 'tax' ->> 'percentage')::float / 100)))) AS expected_tax_amount
        FROM "Transactions"
        WHERE "taxAmount" IS NOT NULL
        AND "taxAmount" != 0
        AND data -> 'tax' IS NOT NULL
        AND "type" = 'CREDIT'
        AND "kind" = 'CONTRIBUTION'
        AND "deletedAt" IS NULL
        AND "isRefund" IS NOT TRUE
        AND -(amount - ROUND("amount"  / (1 + ((data -> 'tax' ->> 'percentage')::float / 100))))  != "taxAmount"
      ) UPDATE "Transactions" t
      SET
        -- Update amount and amountInHostCurrency only for DEBIT
        "amount" = CASE WHEN "type" = 'DEBIT' THEN t."amount" + t."taxAmount" - "expected_tax_amount" ELSE "amount" END,
        "amountInHostCurrency" = CASE WHEN "type" = 'DEBIT' THEN "amountInHostCurrency" + t."taxAmount" - "expected_tax_amount" ELSE "amountInHostCurrency" END,
        -- Update netAmountInCollectiveCurrency only for CREDIT
        "netAmountInCollectiveCurrency" = CASE WHEN "type" = 'CREDIT' THEN "netAmountInCollectiveCurrency" - t."taxAmount" + "expected_tax_amount" ELSE "netAmountInCollectiveCurrency" END,
        -- Update taxAmount and data for all
        "taxAmount" = "expected_tax_amount",
        "data" = jsonb_set(t.data, '{fieldsBeforeMigration20230303135204}', jsonb_build_object('taxAmount', t."taxAmount", 'amount', t."amount", 'amountInHostCurrency', t."amountInHostCurrency", 'netAmountInCollectiveCurrency', t."netAmountInCollectiveCurrency"))
      FROM "invalid_transactions"
      WHERE t."TransactionGroup" = invalid_transactions."TransactionGroup"
      AND t."taxAmount" IS NOT NULL
      AND t."kind" = 'CONTRIBUTION'
      RETURNING t.*
    `,
      { type: queryInterface.sequelize.QueryTypes.SELECT },
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `
        UPDATE "Transactions" t
        SET
          "amount" = (data -> 'fieldsBeforeMigration20230303135204' ->> 'amount')::integer,
          "amountInHostCurrency" = (data -> 'fieldsBeforeMigration20230303135204' ->> 'amountInHostCurrency')::integer,
          "netAmountInCollectiveCurrency" = (data -> 'fieldsBeforeMigration20230303135204' ->> 'netAmountInCollectiveCurrency')::integer,
          "taxAmount" = (data -> 'fieldsBeforeMigration20230303135204' ->> 'taxAmount')::integer,
          "data" = t.data - 'fieldsBeforeMigration20230303135204'
        WHERE "data" -> 'fieldsBeforeMigration20230303135204' IS NOT NULL
        RETURNING t.*
        `,
      { type: queryInterface.sequelize.QueryTypes.SELECT },
    );
  },
};
