'use strict';

/**
 * HostFee was wrongly calculated on top of totalAmount, which includes feesOnTop.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const [transactions, result] = await queryInterface.sequelize.query(`
      SELECT
        t.id,
        t."type",
        t.amount,
        t.currency,
        t."platformFeeInHostCurrency",
        t."hostFeeInHostCurrency",
        t."hostCurrencyFxRate",
        t."hostCurrency",
        t."paymentProcessorFeeInHostCurrency",
        t."amountInHostCurrency",
        t."netAmountInCollectiveCurrency",
        t."TransactionGroup",
        c."hostFeePercent"
      FROM
        "Transactions" t,
        "Orders" o,
        "Collectives" c
      WHERE
        (t."deletedAt" IS NULL)
        AND t."type" = 'CREDIT'
        AND t."HostCollectiveId" = c.id
        AND t."hostFeeInHostCurrency" < 0
        AND t."OrderId" = o.id
        AND t."TransactionGroup" != '6df7bbd6-7d9e-48a1-8717-c0dc46f95bb7'
        AND t."data"->>'isFeesOnTop' = 'true'
        AND o."data"->'platformFee' IS NOT NULL
      ORDER BY
        t."createdAt" desc, "TransactionGroup", t."type" desc
    `);

    for (const credit of transactions) {
      console.info(`Fixing TransactionGroup ${credit.TransactionGroup}...`);
      const creditHostFeeInHostCurrency = -1 * credit.amount * (credit.hostFeePercent / 100);
      const creditNetAmountInCollectiveCurrency =
        credit.amountInHostCurrency + creditHostFeeInHostCurrency + credit.paymentProcessorFeeInHostCurrency;

      const debitAmount = -1 * creditNetAmountInCollectiveCurrency;
      const debitAmountInHostCurrency = -1 * creditNetAmountInCollectiveCurrency;

      await queryInterface.sequelize.query(
        `
        BEGIN;

        UPDATE "Transactions"
        SET
          "hostFeeInHostCurrency" = :creditHostFeeInHostCurrency,
          "netAmountInCollectiveCurrency" = :creditNetAmountInCollectiveCurrency
        WHERE "id" = :creditId;

        UPDATE "Transactions"
        SET
          "hostFeeInHostCurrency" = :creditHostFeeInHostCurrency,
          "amount" = :debitAmount,
          "amountInHostCurrency" = :debitAmountInHostCurrency
        WHERE "type" = 'DEBIT' AND "TransactionGroup" = :TransactionGroup;

        COMMIT;
      `,
        {
          replacements: {
            creditHostFeeInHostCurrency,
            creditNetAmountInCollectiveCurrency,
            debitAmount,
            debitAmountInHostCurrency,
            TransactionGroup: credit.TransactionGroup,
            creditId: credit.id,
          },
        },
      );
    }

    console.info(`\nDone! Fixed ${result.rowCount} transaction pairs.`);
  },

  down: async () => {},
};
