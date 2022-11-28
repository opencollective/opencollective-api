'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transaction_balances_collective_id"
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
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "latest_balances_collective_id"
      ON "CollectiveBalanceCheckpoint"("CollectiveId")
    `);

    await queryInterface.sequelize.query(`
      CREATE OR REPLACE VIEW "CurrentCollectiveBalance" as (
        SELECT
          tb."CollectiveId",
          tb."balance" + coalesce(t."netAmountInHostCurrency", 0) "netAmountInHostCurrency",
          coalesce(disputed."netAmountInHostCurrency", 0) "disputedNetAmountInHostCurrency",
          tb."hostCurrency"
        from "TransactionBalances" tb
        inner JOIN "CollectiveBalanceCheckpoint" cbc ON tb."id" = cbc."id"
        left join lateral (
          select
            sum(t."amountInHostCurrency") +
              sum(coalesce(t."platformFeeInHostCurrency", 0)) +
              sum(coalesce(t."hostFeeInHostCurrency", 0)) +
              sum(coalesce(t."paymentProcessorFeeInHostCurrency", 0)) +
              sum(coalesce(t."taxAmount" * t."hostCurrencyFxRate", 0)) "netAmountInHostCurrency"
          from "Transactions" t
          where t."CollectiveId" = tb."CollectiveId"
            and t.id > tb."id"
            and t."deletedAt" is null
          group by t."CollectiveId"
        ) as t on true
        left join lateral (
          select
            sum(t."amountInHostCurrency") +
              sum(coalesce(t."platformFeeInHostCurrency", 0)) +
              sum(coalesce(t."hostFeeInHostCurrency", 0)) +
              sum(coalesce(t."paymentProcessorFeeInHostCurrency", 0)) +
              sum(coalesce(t."taxAmount" * t."hostCurrencyFxRate", 0)) "netAmountInHostCurrency"
          from "Transactions" t
          where t."CollectiveId" = tb."CollectiveId"
            and t."deletedAt" is null
            and t."isDisputed"
            and t."RefundTransactionId" is null
          group by t."CollectiveId"
        ) as disputed on true
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transaction_balances_collective_id"
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__collective_id_sorted"
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__is_disputed"
    `);

    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CollectiveBalanceCheckpoint"`);

    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CurrentCollectiveBalance"`);
  },
};
