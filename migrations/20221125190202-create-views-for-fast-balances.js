'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__collective_id_sorted"
      ON "Transactions"("CollectiveId", "HostCollectiveId", "hostCurrency", id ASC)
      WHERE "deletedAt" is null;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__is_disputed"
      ON "Transactions"("CollectiveId", "HostCollectiveId", "hostCurrency", id ASC)
      WHERE "deletedAt" is null and "isDisputed" = true and "RefundTransactionId" is null;
    `);

    await queryInterface.sequelize.query(`
      CREATE OR REPLACE VIEW "CurrentCollectiveBalance" as (
        with "LatestBalances" AS (
          select MAX("id") as "id"
          from "TransactionBalances"
          group by "CollectiveId"
        )
        select
          tb."CollectiveId",
          tb."balance" + coalesce(t."netAmountInHostCurrency", 0) "netAmountInHostCurrency",
          -- disputed transactions
          coalesce(disputed."netAmountInHostCurrency", 0) "disputedNetAmountInHostCurrency"
        from "TransactionBalances" tb
        inner JOIN "LatestBalances" lb ON tb."id" = lb."id"
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
      DROP VIEW "CurrentCollectiveBalance";
      DROP MATERIALIZED VIEW "CollectiveBalanceCheckpoint";

      DROP INDEX "transactions__collective_id_sorted";
      DROP INDEX "transactions__is_disputed";
    `);
  },
};
