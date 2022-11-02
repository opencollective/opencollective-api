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
      CREATE MATERIALIZED VIEW IF NOT EXISTS "CollectiveBalanceCheckpoint" as (
        with "ActiveCollectives" as (
          select c."id" as "ActiveCollectiveId", c."HostCollectiveId" 
          from "Collectives" c
          where c."deletedAt" is null and c."isActive" is true
        )
        select 
          t."CollectiveId",
          c."HostCollectiveId",
          t."hostCurrency",
          max(t."id") "lastTransactionId",
          sum(t."amountInHostCurrency") "amountInHostCurrency",
          sum(t."amountInHostCurrency") + 
            sum(coalesce(t."platformFeeInHostCurrency", 0)) + 
            sum(coalesce(t."hostFeeInHostCurrency", 0)) + 
            sum(coalesce(t."paymentProcessorFeeInHostCurrency", 0)) + 
            sum(coalesce(t."taxAmount" * t."hostCurrencyFxRate", 0)) "netAmountInHostCurrency"
        from "ActiveCollectives" c
        join "Transactions" t on t."CollectiveId" = c."ActiveCollectiveId"
        where t."deletedAt" is null
        group by t."hostCurrency", t."CollectiveId", c."HostCollectiveId"
      );
    
      CREATE OR REPLACE VIEW "CurrentCollectiveBalance" as (
        select
          b."CollectiveId",
          b."HostCollectiveId",
          b."hostCurrency",
          b."amountInHostCurrency" + coalesce(t."amountInHostCurrency", 0) "amountInHostCurrency",
          b."netAmountInHostCurrency" + coalesce(t."netAmountInHostCurrency", 0) "netAmountInHostCurrency",
          -- disputed transactions
          coalesce(disputed."amountInHostCurrency", 0) "disputedAmountInHostCurrency",
          coalesce(disputed."netAmountInHostCurrency", 0) "disputedNetAmountInHostCurrency"
        from "CollectiveBalanceCheckpoint" b
        left join lateral (
          select
            sum(t.amount) "amountInCollectiveCurrency",
            sum(t."amountInHostCurrency") "amountInHostCurrency",
            sum(t."amountInHostCurrency") + 
              sum(coalesce(t."platformFeeInHostCurrency", 0)) + 
              sum(coalesce(t."hostFeeInHostCurrency", 0)) + 
              sum(coalesce(t."paymentProcessorFeeInHostCurrency", 0)) + 
              sum(coalesce(t."taxAmount" * t."hostCurrencyFxRate", 0)) "netAmountInHostCurrency"
          from "Transactions" t 
          where t."CollectiveId" = b."CollectiveId" and t."HostCollectiveId" = b."HostCollectiveId" and t."hostCurrency" = b."hostCurrency" and t.id > b."lastTransactionId" and t."deletedAt" is null
          group by t."CollectiveId"
        ) as t on true
        left join lateral (
          select
            sum(t.amount) "amountInCollectiveCurrency",
            sum(t."amountInHostCurrency") "amountInHostCurrency",
            sum(t."amountInHostCurrency") + 
              sum(coalesce(t."platformFeeInHostCurrency", 0)) + 
              sum(coalesce(t."hostFeeInHostCurrency", 0)) + 
              sum(coalesce(t."paymentProcessorFeeInHostCurrency", 0)) + 
              sum(coalesce(t."taxAmount" * t."hostCurrencyFxRate", 0)) "netAmountInHostCurrency"
          from "Transactions" t 
          where t."CollectiveId" = b."CollectiveId" and t."HostCollectiveId" = b."HostCollectiveId" and t."hostCurrency" = b."hostCurrency" and t."deletedAt" is null and t."isDisputed" and t."RefundTransactionId" is null
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
      DROP INDEX "transactions__is_disputed"
    `);
  },
};
