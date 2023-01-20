'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`WITH "ExpenseRefundsCreditsTransactionsUpdate" AS (
      SELECT tr.id as "id",
        - (t."amount" ) as "amount",
        - (t."amountInHostCurrency") as "amountInHostCurrency",
        - (t."netAmountInCollectiveCurrency" - t."paymentProcessorFeeInHostCurrency") as "netAmountInCollectiveCurrency"
      FROM "Transactions" t
      INNER JOIN "Transactions" tr ON t."RefundTransactionId" = tr."id" AND tr."deletedAt" IS NULL
      WHERE t."kind" = 'EXPENSE'
        AND t."RefundTransactionId" IS NOT NULL
        AND t."type" = 'DEBIT'
        AND t."paymentProcessorFeeInHostCurrency" != 0
        AND t."currency" = t."hostCurrency"
        AND t."deletedAt" IS NULL
        AND EXISTS (SELECT * FROM "Transactions" WHERE "kind" = 'PAYMENT_PROCESSOR_COVER' AND "TransactionGroup" = tr."TransactionGroup")
      )
      UPDATE "Transactions"
      SET "amount" = erctu."amount",
        "amountInHostCurrency" = erctu."amountInHostCurrency",
        "netAmountInCollectiveCurrency" = erctu."netAmountInCollectiveCurrency",
        "updatedAt" = NOW()
      FROM "ExpenseRefundsCreditsTransactionsUpdate" erctu
      WHERE "Transactions"."id" = erctu."id"`);

    await queryInterface.sequelize.query(`WITH "ExpenseRefundsDebitsTransactionsUpdate" AS (
      SELECT tr.id as "id",
        - (t."amount" + t."paymentProcessorFeeInHostCurrency") as "amount",
        - (t."amountInHostCurrency" + t."paymentProcessorFeeInHostCurrency") as "amountInHostCurrency",
        - (t."netAmountInCollectiveCurrency") as "netAmountInCollectiveCurrency"
      FROM "Transactions" t
      INNER JOIN "Transactions" tr ON t."RefundTransactionId" = tr."id" AND tr."deletedAt" IS NULL
      WHERE t."kind" = 'EXPENSE'
        AND t."RefundTransactionId" IS NOT NULL
        AND t."type" = 'CREDIT'
        AND t."paymentProcessorFeeInHostCurrency" != 0
        AND t."currency" = t."hostCurrency"
        AND t."deletedAt" IS NULL
        AND EXISTS (SELECT * FROM "Transactions" WHERE "kind" = 'PAYMENT_PROCESSOR_COVER' AND "TransactionGroup" = tr."TransactionGroup")
      )
      UPDATE "Transactions"
      SET "amount" = erdtu."amount",
        "amountInHostCurrency" = erdtu."amountInHostCurrency",
        "netAmountInCollectiveCurrency" = erdtu."netAmountInCollectiveCurrency",
        "updatedAt" = NOW()
      FROM "ExpenseRefundsDebitsTransactionsUpdate" erdtu
      WHERE "Transactions"."id" = erdtu."id"`);
  },

  async down() {
    // No rollback
  },
};
