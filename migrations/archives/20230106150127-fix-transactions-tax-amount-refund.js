'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // See https://github.com/opencollective/opencollective/issues/5438 for the why
    // A small shortcut has been taken in this query since `hostCurrencyFxRate` is always 1 for fixed entries
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET
        "taxAmount" = -invalid_transactions."taxAmount", -- Make it positive
        "data" = jsonb_set("data"::jsonb, '{migration}', '"20230106150127-fix-transactions-tax-amount-refund"'::jsonb),
        "amount" = CASE WHEN "type" = 'DEBIT' THEN "amount" ELSE "amount" + invalid_transactions."taxAmount"  END,
        "netAmountInCollectiveCurrency" = CASE WHEN "type" = 'CREDIT' THEN "netAmountInCollectiveCurrency" ELSE "netAmountInCollectiveCurrency" - invalid_transactions."taxAmount" END
      FROM (
        SELECT t.id AS transaction_id, refund.id AS refund_id, t."taxAmount" as "taxAmount"
        FROM "Transactions" t
        INNER JOIN "Transactions" refund ON t."RefundTransactionId" = refund.id AND refund."isRefund" IS TRUE
        WHERE t."taxAmount" IS NOT NULL
        AND t."isRefund" IS NOT TRUE
        AND t."taxAmount" < 0
      ) invalid_transactions
      WHERE "Transactions".id = invalid_transactions.refund_id
    `);
  },

  async down() {
    console.log(
      'Rollback can be done manually by looking at data.migration = "20230106150127-fix-transactions-tax-amount-refund"',
    );
  },
};
