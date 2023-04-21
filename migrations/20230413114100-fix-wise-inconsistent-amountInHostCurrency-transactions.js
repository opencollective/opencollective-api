'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      BEGIN;
      CREATE TEMP TABLE tmp_impacted_debits AS (
        SELECT
          t."TransactionGroup"
        FROM
          "Transactions" t
        INNER JOIN "Expenses" e ON
          t."ExpenseId" = e."id"
        WHERE
          t."type" = 'DEBIT'
          AND t."RefundTransactionId" IS NULL
          AND t."deletedAt" IS NULL
          AND t."HostCollectiveId" != 98478
          -- Ignore SCN
          AND e.data IS NOT NULL
          AND t.data ->> 'transfer' IS NOT NULL
          AND (
            (
              -- First bug: sourceValue not a reliable source of truth
            (
                e."data"#>>'{paymentOption,sourceAmount}'
              )::FLOAT - (
                e.data #>> '{paymentOption,fee,total}'
              )::FLOAT != (
                e."data"#>>'{transfer,sourceValue}'
              )::FLOAT
                AND (
                  (
                    "feesPayer" = 'PAYEE'
                      AND t."amountInHostCurrency" = ROUND(-100 * (t."data"#>>'{transfer,sourceValue}')::FLOAT) - t."paymentProcessorFeeInHostCurrency"
                  )
                    OR (
                      "feesPayer" = 'COLLECTIVE'
                        AND t."amountInHostCurrency" != ROUND(-100 * (t."data" #>> '{transfer,sourceValue}')::FLOAT)
                    )
                )
            )
              OR (
                -- Expenses impacted by the feesPayer=PAYEE bug
                e."feesPayer" = 'PAYEE'
                  AND ROUND(-100 * (e."data" #>> '{paymentOption,sourceAmount}')::FLOAT) > e.amount
              )
          )
          -- Ignore transactions related to OCNZ settlements being addressed in another issue
          AND t."TransactionGroup" not in ('825dc07a-6881-4ec8-9607-d9a8e41a900e', '7cc93f5a-79a8-48c6-a010-ad214376236b')
        GROUP BY
          t.id
        ORDER BY
          t.id DESC
      );


      CREATE TEMP TABLE tmp_impacted_transactions AS (
        SELECT *
        FROM "Transactions" t
        WHERE t."TransactionGroup" IN (SELECT "TransactionGroup" FROM tmp_impacted_debits)
        AND kind = 'EXPENSE'
        AND "RefundTransactionId" IS NULL
        AND "deletedAt" IS NULL
      );

      -- Update Debits
      UPDATE "Transactions" SET
        "amountInHostCurrency" = ROUND(((e.data#>>'{paymentOption,sourceAmount}')::FLOAT - (e.data #>> '{paymentOption,fee,total}')::FLOAT) * -100.0),
        "amount" = ROUND(ROUND(((e.data #>> '{paymentOption,sourceAmount}')::FLOAT - (e.data #>> '{paymentOption,fee,total}')::FLOAT) * -100.0) / t."hostCurrencyFxRate"),
        "netAmountInCollectiveCurrency" = ROUND((e.data #>> '{paymentOption,sourceAmount}')::FLOAT * -100 / t."hostCurrencyFxRate"),
        "paymentProcessorFeeInHostCurrency" = ROUND((e.data #>> '{paymentOption,fee,total}')::FLOAT * -100),
        "data" = jsonb_set(
          t.data,
          '{expenseToHostFxRate}',
          to_json(round(((((e.data #>> '{paymentOption,sourceAmount}')::FLOAT - (e.data #>> '{paymentOption,fee,total}')::FLOAT) )* 100.0 / e."amount")::NUMERIC, 2))::JSONB
        ) || jsonb_build_object('fieldsBeforeMigration20230413114100', jsonb_build_object(
          'netAmountInCollectiveCurrency', t."netAmountInCollectiveCurrency",
          'amountInHostCurrency', t."amountInHostCurrency",
          'paymentProcessorFeeInHostCurrency', t."paymentProcessorFeeInHostCurrency",
          'amount', t.amount,
          'expenseToHostFxRate', t.data -> 'expenseToHostFxRate'
        ))
      FROM
        tmp_impacted_transactions t
      INNER JOIN "Expenses" e ON
        e."id" = t."ExpenseId"
      WHERE
        "Transactions"."id" = t."id" AND t.type = 'DEBIT'; 

      -- Update Credits
      UPDATE "Transactions" SET
        "amount" = ROUND((e.data #>> '{paymentOption,sourceAmount}')::FLOAT * 100 / t."hostCurrencyFxRate"),
        "amountInHostCurrency" = ROUND(ROUND((e.data #>> '{paymentOption,sourceAmount}')::FLOAT * 100 * COALESCE(t."hostCurrencyFxRate", 1))),
        "netAmountInCollectiveCurrency" = ROUND(ROUND(((e.data #>> '{paymentOption,sourceAmount}')::FLOAT - (e.data #>> '{paymentOption,fee,total}')::FLOAT) * 100.0) / t."hostCurrencyFxRate"),
        "paymentProcessorFeeInHostCurrency" = ROUND((e.data #>> '{paymentOption,fee,total}')::FLOAT * -100 * COALESCE((t."data"->'oppositeTransactionHostCurrencyFxRate')::FLOAT, 1)),
        "data" = jsonb_set(
          t.data,
          '{expenseToHostFxRate}',
          to_json(round(((((e.data #>> '{paymentOption,sourceAmount}')::FLOAT - (e.data #>> '{paymentOption,fee,total}')::FLOAT) )* 100.0 / e."amount")::NUMERIC, 2))::JSONB
        ) || jsonb_build_object('fieldsBeforeMigration20230413114100', jsonb_build_object(
          'netAmountInCollectiveCurrency', t."netAmountInCollectiveCurrency",
          'amountInHostCurrency', t."amountInHostCurrency",
          'paymentProcessorFeeInHostCurrency', t."paymentProcessorFeeInHostCurrency",
          'amount', t.amount,
          'expenseToHostFxRate', t.data -> 'expenseToHostFxRate'
        ))
      FROM
        tmp_impacted_transactions t
      INNER JOIN "Expenses" e ON
        e."id" = t."ExpenseId"
      WHERE
        "Transactions"."id" = t."id" AND t.type = 'CREDIT'; 

      COMMIT;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions" t
      SET
        "amount" = (data -> 'fieldsBeforeMigration20230413114100' ->> 'amount')::integer,
        "amountInHostCurrency" = (data -> 'fieldsBeforeMigration20230413114100' ->> 'amountInHostCurrency')::integer,
        "paymentProcessorFeeInHostCurrency" = (data -> 'fieldsBeforeMigration20230413114100' ->> 'paymentProcessorFeeInHostCurrency')::integer,
        "netAmountInCollectiveCurrency" = (data -> 'fieldsBeforeMigration20230413114100' ->> 'netAmountInCollectiveCurrency')::integer,
        "data" = (t.data - 'fieldsBeforeMigration20230413114100') || jsonb_build_object('expenseToHostFxRate', data -> 'fieldsBeforeMigration20230413114100' -> 'expenseToHostFxRate')
      WHERE "data" -> 'fieldsBeforeMigration20230413114100' IS NOT NULL;
    `);
  },
};
