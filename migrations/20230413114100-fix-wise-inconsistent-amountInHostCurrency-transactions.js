'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      BEGIN;
      -- Create a temporary table with the transactions that need to be updated with ID and correct amounts
      CREATE TEMP TABLE "AffectedTransactions" AS (
        SELECT
          t."id",
          t."type",
          ROUND(-1 * (
            (
              e."data"#>>'{paymentOption,sourceAmount}'
            )::NUMERIC * 100
          ) - t."paymentProcessorFeeInHostCurrency") AS "correctAmount",
          ROUND(-1 * (
            (
              e."data"#>>'{paymentOption,sourceAmount}'
            )::NUMERIC * 100
          )) AS "correctNetAmount"
        FROM
          "Transactions" t
        LEFT JOIN "Expenses" e ON
          e."id" = t."ExpenseId"
        WHERE
          t."ExpenseId" IN (
            SELECT
              DISTINCT(
                e."id"
              )
            FROM
              "Transactions" t
            LEFT JOIN "Expenses" e ON
              t."ExpenseId" = e."id"
            WHERE
                t."deletedAt" IS NULL
              AND t."RefundTransactionId" IS NULL
              AND t."isRefund" IS FALSE
              AND t."RefundTransactionId" IS NULL
              AND t."isRefund" IS FALSE
              AND e."data"->'paymentOption' IS NOT NULL
              AND e."feesPayer" = 'PAYEE'
              AND t."type" = 'DEBIT'
              AND ABS(t."amountInHostCurrency") != (
                e."data"#>>'{paymentOption,sourceAmount}'
              )::NUMERIC * 100 - (
                e."data"#>>'{paymentOption,fee,total}'
              )::NUMERIC * 100
                AND ABS(t."amountInHostCurrency")::NUMERIC = (
                  t."data"#>>'{transfer,sourceValue}'
                )::NUMERIC * 100 - ABS(t."paymentProcessorFeeInHostCurrency")
                  AND t."paymentProcessorFeeInHostCurrency" + t."amountInHostCurrency" != -1 * (
                    (
                      e."data"#>>'{paymentOption,sourceAmount}'
                    )::NUMERIC * 100 - (
                      e."data"#>>'{paymentOption,fee,total}'
                    )::NUMERIC * 100
                  )
          )
      );

      -- Update DEBIT transactions
      UPDATE
        "Transactions" AS t
        SET
        "amount" = rt."correctAmount",
        "amountInHostCurrency" = rt."correctAmount",
        "netAmountInCollectiveCurrency" = rt."correctNetAmount",
        "data" = jsonb_set(t.data, '{fieldsBeforeMigration20230413114100}', jsonb_build_object('amount', t."amount", 'amountInHostCurrency', t."amountInHostCurrency", 'netAmountInCollectiveCurrency', t."netAmountInCollectiveCurrency"))
      FROM
        "AffectedTransactions" AS rt
      WHERE
        rt."type" = 'DEBIT'
        AND t."id" = rt."id";

      -- Update CREDIT transactions
      UPDATE
        "Transactions" AS t
        SET
        "amount" = ABS(rt."correctNetAmount"),
        "amountInHostCurrency" = ABS(rt."correctNetAmount"),
        "netAmountInCollectiveCurrency" = ABS(rt."correctAmount"),
        "data" = jsonb_set(t.data, '{fieldsBeforeMigration20230413114100}', jsonb_build_object('amount', t."amount", 'amountInHostCurrency', t."amountInHostCurrency", 'netAmountInCollectiveCurrency', t."netAmountInCollectiveCurrency"))
      FROM
        "AffectedTransactions" AS rt
      WHERE
        rt."type" = 'CREDIT'
        AND t."id" = rt."id";

      COMMIT;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions" t
      SET
        "amount" = (data -> 'fieldsBeforeMigration20230413114100' ->> 'amount')::integer,
        "amountInHostCurrency" = (data -> 'fieldsBeforeMigration20230413114100' ->> 'amountInHostCurrency')::integer,
        "netAmountInCollectiveCurrency" = (data -> 'fieldsBeforeMigration20230413114100' ->> 'netAmountInCollectiveCurrency')::integer,
        "data" = t.data - 'fieldsBeforeMigration20230413114100'
      WHERE "data" -> 'fieldsBeforeMigration20230413114100' IS NOT NULL;
    `);
  },
};
