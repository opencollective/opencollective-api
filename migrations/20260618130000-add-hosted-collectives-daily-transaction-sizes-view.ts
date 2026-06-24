'use strict';

/**
 * Per-transaction-size histogram source for hosted collectives.
 *
 * Pre-aggregates each clean contribution/payout transaction into a fixed amount band (front-weighted
 * toward small amounts), per day / host / collective / kindClass / contributionFrequency. Powers the
 * "By size" and "By type" views on the hosted-account overview.
 *
 * `amountBand` emits an enum TOKEN encoding both of the band's bounds in host-currency units
 * (`GT_<lower>_LTE_<upper>`, or `GT_<lower>` for the overflow); bands are upper-inclusive. `kindClass` and
 * `contributionFrequency` likewise emit enum tokens. The metric source declares these same tokens as
 * GraphQL enums (a drift-guard test asserts the view's distinct tokens match the declared values).
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "HostedCollectivesDailyTransactionSizes";`);
    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW "HostedCollectivesDailyTransactionSizes" AS (
        SELECT
          (t."createdAt" AT TIME ZONE 'UTC')::date AS "day",
          t."HostCollectiveId",
          t."CollectiveId",
          c."ParentCollectiveId",
          c.type AS "collectiveType",
          h.currency AS "hostCurrency",
          CASE WHEN t.type = 'CREDIT' THEN 'CONTRIBUTION' ELSE 'PAYOUT' END AS "kindClass",
          CASE
            WHEN t.kind = 'ADDED_FUNDS' THEN 'ADDED_FUNDS'
            WHEN t.kind = 'CONTRIBUTION' AND o.interval IS NOT NULL THEN 'RECURRING'
            WHEN t.kind = 'CONTRIBUTION' THEN 'ONE_TIME'
            ELSE 'OTHER'
          END AS "contributionFrequency",
          CASE
            WHEN abs(t."amountInHostCurrency") <= 500     THEN 'GT_0_LTE_5'
            WHEN abs(t."amountInHostCurrency") <= 1000    THEN 'GT_5_LTE_10'
            WHEN abs(t."amountInHostCurrency") <= 2500    THEN 'GT_10_LTE_25'
            WHEN abs(t."amountInHostCurrency") <= 5000    THEN 'GT_25_LTE_50'
            WHEN abs(t."amountInHostCurrency") <= 7500    THEN 'GT_50_LTE_75'
            WHEN abs(t."amountInHostCurrency") <= 10000   THEN 'GT_75_LTE_100'
            WHEN abs(t."amountInHostCurrency") <= 15000   THEN 'GT_100_LTE_150'
            WHEN abs(t."amountInHostCurrency") <= 20000   THEN 'GT_150_LTE_200'
            WHEN abs(t."amountInHostCurrency") <= 25000   THEN 'GT_200_LTE_250'
            WHEN abs(t."amountInHostCurrency") <= 50000   THEN 'GT_250_LTE_500'
            WHEN abs(t."amountInHostCurrency") <= 100000  THEN 'GT_500_LTE_1000'
            WHEN abs(t."amountInHostCurrency") <= 200000  THEN 'GT_1000_LTE_2000'
            WHEN abs(t."amountInHostCurrency") <= 500000  THEN 'GT_2000_LTE_5000'
            WHEN abs(t."amountInHostCurrency") <= 1000000 THEN 'GT_5000_LTE_10000'
            WHEN abs(t."amountInHostCurrency") <= 2500000 THEN 'GT_10000_LTE_25000'
            WHEN abs(t."amountInHostCurrency") <= 5000000 THEN 'GT_25000_LTE_50000'
            ELSE 'GT_50000'
          END AS "amountBand",
          COUNT(*) AS "transactionCount",
          COALESCE(SUM(abs(t."amountInHostCurrency")), 0) AS "amount"
        FROM "Transactions" t
          INNER JOIN "Collectives" h ON t."HostCollectiveId" = h.id AND h."deletedAt" IS NULL
          INNER JOIN "Collectives" c ON t."CollectiveId" = c.id AND c."deletedAt" IS NULL
          LEFT  JOIN "Orders" o ON o.id = t."OrderId"
        WHERE t."deletedAt" IS NULL
          AND t."HostCollectiveId" IS NOT NULL
          AND t."hostCurrency" = h.currency
          AND COALESCE(c."ParentCollectiveId", c.id) != t."HostCollectiveId"
          AND NOT t."isRefund" AND t."RefundTransactionId" IS NULL AND NOT t."isInternal"
          AND (
            t.type = 'CREDIT'
            OR (t.type = 'DEBIT' AND t.kind <> ALL('{HOST_FEE,PAYMENT_PROCESSOR_FEE}'::"enum_Transactions_kind"[]))
          )
        GROUP BY
          (t."createdAt" AT TIME ZONE 'UTC')::date,
          t."HostCollectiveId",
          t."CollectiveId",
          c."ParentCollectiveId",
          c.type,
          h.currency,
          CASE WHEN t.type = 'CREDIT' THEN 'CONTRIBUTION' ELSE 'PAYOUT' END,
          CASE
            WHEN t.kind = 'ADDED_FUNDS' THEN 'ADDED_FUNDS'
            WHEN t.kind = 'CONTRIBUTION' AND o.interval IS NOT NULL THEN 'RECURRING'
            WHEN t.kind = 'CONTRIBUTION' THEN 'ONE_TIME'
            ELSE 'OTHER'
          END,
          CASE
            WHEN abs(t."amountInHostCurrency") <= 500     THEN 'GT_0_LTE_5'
            WHEN abs(t."amountInHostCurrency") <= 1000    THEN 'GT_5_LTE_10'
            WHEN abs(t."amountInHostCurrency") <= 2500    THEN 'GT_10_LTE_25'
            WHEN abs(t."amountInHostCurrency") <= 5000    THEN 'GT_25_LTE_50'
            WHEN abs(t."amountInHostCurrency") <= 7500    THEN 'GT_50_LTE_75'
            WHEN abs(t."amountInHostCurrency") <= 10000   THEN 'GT_75_LTE_100'
            WHEN abs(t."amountInHostCurrency") <= 15000   THEN 'GT_100_LTE_150'
            WHEN abs(t."amountInHostCurrency") <= 20000   THEN 'GT_150_LTE_200'
            WHEN abs(t."amountInHostCurrency") <= 25000   THEN 'GT_200_LTE_250'
            WHEN abs(t."amountInHostCurrency") <= 50000   THEN 'GT_250_LTE_500'
            WHEN abs(t."amountInHostCurrency") <= 100000  THEN 'GT_500_LTE_1000'
            WHEN abs(t."amountInHostCurrency") <= 200000  THEN 'GT_1000_LTE_2000'
            WHEN abs(t."amountInHostCurrency") <= 500000  THEN 'GT_2000_LTE_5000'
            WHEN abs(t."amountInHostCurrency") <= 1000000 THEN 'GT_5000_LTE_10000'
            WHEN abs(t."amountInHostCurrency") <= 2500000 THEN 'GT_10000_LTE_25000'
            WHEN abs(t."amountInHostCurrency") <= 5000000 THEN 'GT_25000_LTE_50000'
            ELSE 'GT_50000'
          END
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "hosted_collectives_daily_transaction_sizes__unique_index"
        ON "HostedCollectivesDailyTransactionSizes" ("HostCollectiveId", "CollectiveId", "day", "kindClass", "contributionFrequency", "amountBand");
      CREATE INDEX IF NOT EXISTS "hosted_collectives_daily_transaction_sizes__host_day"
        ON "HostedCollectivesDailyTransactionSizes" ("HostCollectiveId", "day")
        INCLUDE ("CollectiveId", "ParentCollectiveId", "kindClass", "contributionFrequency", "amountBand", "transactionCount", "amount");
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "HostedCollectivesDailyTransactionSizes";`);
  },
};
