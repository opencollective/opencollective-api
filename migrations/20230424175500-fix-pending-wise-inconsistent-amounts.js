'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      BEGIN;
      DROP TABLE IF EXISTS "tmp_impacted_debits", "tmp_impacted_transactions";
      CREATE TEMP TABLE tmp_impacted_debits AS (
        SELECT
          t."TransactionGroup"
        FROM
          "Transactions" t
        INNER JOIN "Expenses" e ON
          t."ExpenseId" = e."id"
        WHERE
          t."type" = 'DEBIT'
          AND t.kind = 'EXPENSE'
          AND t."isRefund" IS FALSE
          AND t."RefundTransactionId" IS NULL
          AND t."netAmountInCollectiveCurrency" != ROUND((e."data" #>> '{quote,sourceAmount}')::NUMERIC * -100)
        GROUP BY
          t.id
        ORDER BY
          t.id DESC
      );


      CREATE TEMP TABLE tmp_impacted_transactions AS (
        SELECT *
        FROM "Transactions" t
        WHERE t."TransactionGroup" IN (SELECT "TransactionGroup" FROM tmp_impacted_debits)
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
        ) || jsonb_build_object('fieldsBeforeMigration20230424175500', jsonb_build_object(
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
        ) || jsonb_build_object('fieldsBeforeMigration20230424175500', jsonb_build_object(
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
        "amount" = (data -> 'fieldsBeforeMigration20230424175500' ->> 'amount')::integer,
        "amountInHostCurrency" = (data -> 'fieldsBeforeMigration20230424175500' ->> 'amountInHostCurrency')::integer,
        "paymentProcessorFeeInHostCurrency" = (data -> 'fieldsBeforeMigration20230424175500' ->> 'paymentProcessorFeeInHostCurrency')::integer,
        "netAmountInCollectiveCurrency" = (data -> 'fieldsBeforeMigration20230424175500' ->> 'netAmountInCollectiveCurrency')::integer,
        "data" = (t.data - 'fieldsBeforeMigration20230424175500') || jsonb_build_object('expenseToHostFxRate', data -> 'fieldsBeforeMigration20230424175500' -> 'expenseToHostFxRate')
      WHERE "data" -> 'fieldsBeforeMigration20230424175500' IS NOT NULL;
    `);
  },
};
