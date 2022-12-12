'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transaction_balances__collective_id"
      ON "TransactionBalances"("CollectiveId")
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__collective_id_sorted"
      ON "Transactions"("CollectiveId", id ASC)
      WHERE "deletedAt" is null
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__is_disputed"
      ON "Transactions"("CollectiveId")
      WHERE "deletedAt" is null and "isDisputed" = true and "RefundTransactionId" is null
    `);

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

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transaction_balances__collective_id"
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__collective_id_sorted"
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__is_disputed"
    `);

    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CollectiveBalanceCheckpoint"`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "LatestBalances"`); // Older name in dev, just in case

    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CurrentCollectiveBalance"`);
  },
};
