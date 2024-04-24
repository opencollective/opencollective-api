'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CurrentCollectiveBalance"`);

    // Tweaking the budgetVersion/HostCollectiveId condition
    await queryInterface.sequelize.query(`
    CREATE OR REPLACE VIEW "CurrentCollectiveBalance" as (
      SELECT
        cbc."CollectiveId",
        cbc."balance" + coalesce(t."netAmountInHostCurrency", 0) "netAmountInHostCurrency",
        coalesce(disputed."netAmountInHostCurrency", 0) "disputedNetAmountInHostCurrency",
        cbc."hostCurrency"
      FROM "CollectiveBalanceCheckpoint" cbc
      LEFT JOIN LATERAL (
        SELECT
          SUM(t."amountInHostCurrency") +
            SUM(coalesce(t."platformFeeInHostCurrency", 0)) +
            SUM(coalesce(t."hostFeeInHostCurrency", 0)) +
            SUM(coalesce(t."paymentProcessorFeeInHostCurrency", 0)) +
            SUM(coalesce(t."taxAmount" * t."hostCurrencyFxRate", 0)) "netAmountInHostCurrency"
        FROM "Transactions" t
        WHERE t."CollectiveId" = cbc."CollectiveId"
          AND t."createdAt" > cbc."createdAt"
          AND t."deletedAt" is null
          AND (cbc."budgetVersion" != 'v3' OR t."HostCollectiveId" = cbc."HostCollectiveId")
        GROUP by t."CollectiveId"
      ) as t ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          SUM(t."amountInHostCurrency") +
            SUM(coalesce(t."platformFeeInHostCurrency", 0)) +
            SUM(coalesce(t."hostFeeInHostCurrency", 0)) +
            SUM(coalesce(t."paymentProcessorFeeInHostCurrency", 0)) +
            SUM(coalesce(t."taxAmount" * t."hostCurrencyFxRate", 0)) "netAmountInHostCurrency"
        FROM "Transactions" t
        where t."CollectiveId" = cbc."CollectiveId"
          AND t."deletedAt" is null
          AND t."isDisputed"
          AND t."RefundTransactionId" is null
        GROUP BY t."CollectiveId"
      ) as disputed ON TRUE
    );
  `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CurrentCollectiveBalance"`);

    await queryInterface.sequelize.query(`
    CREATE OR REPLACE VIEW "CurrentCollectiveBalance" as (
      SELECT
        cbc."CollectiveId",
        cbc."balance" + coalesce(t."netAmountInHostCurrency", 0) "netAmountInHostCurrency",
        coalesce(disputed."netAmountInHostCurrency", 0) "disputedNetAmountInHostCurrency",
        cbc."hostCurrency"
      FROM "CollectiveBalanceCheckpoint" cbc
      LEFT JOIN LATERAL (
        SELECT
          SUM(t."amountInHostCurrency") +
            SUM(coalesce(t."platformFeeInHostCurrency", 0)) +
            SUM(coalesce(t."hostFeeInHostCurrency", 0)) +
            SUM(coalesce(t."paymentProcessorFeeInHostCurrency", 0)) +
            SUM(coalesce(t."taxAmount" * t."hostCurrencyFxRate", 0)) "netAmountInHostCurrency"
        FROM "Transactions" t
        WHERE t."CollectiveId" = cbc."CollectiveId"
          AND t."createdAt" > cbc."createdAt"
          AND t."deletedAt" is null
        GROUP by t."CollectiveId"
      ) as t ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          SUM(t."amountInHostCurrency") +
            SUM(coalesce(t."platformFeeInHostCurrency", 0)) +
            SUM(coalesce(t."hostFeeInHostCurrency", 0)) +
            SUM(coalesce(t."paymentProcessorFeeInHostCurrency", 0)) +
            SUM(coalesce(t."taxAmount" * t."hostCurrencyFxRate", 0)) "netAmountInHostCurrency"
        FROM "Transactions" t
        where t."CollectiveId" = cbc."CollectiveId"
          AND t."deletedAt" is null
          AND t."isDisputed"
          AND t."RefundTransactionId" is null
          AND (cbc."budgetVersion" != 'v3' OR t."HostCollectiveId" = cbc."HostCollectiveId")
        GROUP BY t."CollectiveId"
      ) as disputed ON TRUE
    );
  `);
  },
};
