'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const buildQuery = ({
      type,
      newAmount = '"amount"',
      newNetAmountInCollectiveCurrency = '"netAmountInCollectiveCurrency"',
      newAmountInHostCurrency = '"amountInHostCurrency"',
    }) => `
      UPDATE "Transactions"
      SET
        "amount" = ${newAmount},
        "netAmountInCollectiveCurrency" = ${newNetAmountInCollectiveCurrency},
        "amountInHostCurrency" = ${newAmountInHostCurrency},
        "data" = JSONB_SET("data", '{fieldsBeforeMigration20230511095430}', JSONB_BUILD_OBJECT(
          'netAmountInCollectiveCurrency', "netAmountInCollectiveCurrency",
          'amountInHostCurrency', "amountInHostCurrency",
          'amount', "amount"
        ))
      WHERE "ExpenseId" IS NOT NULL
      AND "type" = '${type}'
      AND "taxAmount" != 0
      AND "deletedAt" IS NULL
      AND "RefundTransactionId" IS NULL -- There's only one refund (mark as unpaid) and it is properly reverting the amount
    `;

    // Fix credits
    await queryInterface.sequelize.query(
      buildQuery({
        type: 'CREDIT',
        newAmountInHostCurrency: '"amountInHostCurrency" - ("taxAmount" * "hostCurrencyFxRate")',
        newAmount: '"amount" - "taxAmount"',
      }),
    );

    // Fix debits
    await queryInterface.sequelize.query(
      buildQuery({
        type: 'DEBIT',
        newNetAmountInCollectiveCurrency: '"netAmountInCollectiveCurrency" + "taxAmount"',
      }),
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET
        "amount" = ("data"->'fieldsBeforeMigration20230511095430'->>'amount')::integer,
        "netAmountInCollectiveCurrency" = ("data"->'fieldsBeforeMigration20230511095430'->>'netAmountInCollectiveCurrency')::integer,
        "amountInHostCurrency" = ("data"->'fieldsBeforeMigration20230511095430'->>'amountInHostCurrency')::integer,
        "data" = JSONB_SET("data" - 'fieldsBeforeMigration20230511095430', '{reverted20230511095430}', 'true')
      WHERE "ExpenseId" IS NOT NULL
      AND "taxAmount" != 0
      AND "data"->'fieldsBeforeMigration20230511095430' IS NOT NULL
    `);
  },
};
