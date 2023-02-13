'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CurrentCollectiveBalance"`);

    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CollectiveBalanceCheckpoint"`);

    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS "CollectiveBalanceCheckpoint" AS (
        WITH "LatestTransactions" AS (
          SELECT "CollectiveId", MAX("createdAt") AS "createdAt" FROM "TransactionBalances" GROUP BY "CollectiveId"
        )
        SELECT *
        FROM "TransactionBalances"
        WHERE id IN (
          SELECT MAX(tb."id") FROM "TransactionBalances" tb
          INNER JOIN "LatestTransactions" lt ON lt."CollectiveId" = tb."CollectiveId" AND lt."createdAt" = tb."createdAt"
          GROUP BY tb."CollectiveId"
        )
       )
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "collective_balance_checkpoint__collective_id"
      ON "CollectiveBalanceCheckpoint"("CollectiveId")
    `);

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
          GROUP BY t."CollectiveId"
        ) as disputed ON TRUE
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CurrentCollectiveBalance"`);

    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CollectiveBalanceCheckpoint"`);

    // IMPORTANT: reveert to the older version with known problems!
    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS "CollectiveBalanceCheckpoint" AS (
        WITH "LatestTransactionIds" AS (
          SELECT MAX("id") as "id"
          FROM "TransactionBalances"
          GROUP BY "CollectiveId"
        )
        SELECT tb.*
        FROM "TransactionBalances" tb
        INNER JOIN "LatestTransactionIds" lb ON tb."id" = lb."id"
       )
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "collective_balance_checkpoint__collective_id"
      ON "CollectiveBalanceCheckpoint"("CollectiveId")
    `);

    // IMPORTANT: revert to the older version with known problems!
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE VIEW "CurrentCollectiveBalance" as (
        SELECT
          tb."CollectiveId",
          tb."balance" + coalesce(t."netAmountInHostCurrency", 0) "netAmountInHostCurrency",
          coalesce(disputed."netAmountInHostCurrency", 0) "disputedNetAmountInHostCurrency",
          tb."hostCurrency"
        FROM "TransactionBalances" tb
        INNER JOIN "CollectiveBalanceCheckpoint" cbc ON tb."id" = cbc."id"
        LEFT JOIN LATERAL (
          SELECT
            SUM(t."amountInHostCurrency") +
              SUM(coalesce(t."platformFeeInHostCurrency", 0)) +
              SUM(coalesce(t."hostFeeInHostCurrency", 0)) +
              SUM(coalesce(t."paymentProcessorFeeInHostCurrency", 0)) +
              SUM(coalesce(t."taxAmount" * t."hostCurrencyFxRate", 0)) "netAmountInHostCurrency"
          FROM "Transactions" t
          WHERE t."CollectiveId" = tb."CollectiveId"
            AND t.id > tb."id"
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
          where t."CollectiveId" = tb."CollectiveId"
            AND t."deletedAt" is null
            AND t."isDisputed"
            AND t."RefundTransactionId" is null
          GROUP BY t."CollectiveId"
        ) as disputed ON TRUE
      );
    `);
  },
};
