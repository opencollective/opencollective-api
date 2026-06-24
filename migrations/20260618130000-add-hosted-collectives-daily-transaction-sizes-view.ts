'use strict';

/**
 * Per-transaction-size histogram source for hosted collectives.
 *
 * Pre-aggregates each clean contribution/payout transaction into a fixed amount band (front-weighted
 * toward small amounts), per day / host / collective / kindClass / contributionFrequency. Powers the
 * "By size" and "By type" views on the hosted-account overview. The contribution/payout split mirrors
 * the predicates behind `amountReceived` / `amountSpent` in `HostedCollectivesDailyFinancialActivity`,
 * and `contributionFrequency` (ONE_TIME / RECURRING / ADDED_FUNDS / OTHER) is keyed off the order
 * interval — both CASE expressions are part of the GROUP BY so each combination is a single row.
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
            WHEN abs(t."amountInHostCurrency") <= 500     THEN 0
            WHEN abs(t."amountInHostCurrency") <= 1000    THEN 1
            WHEN abs(t."amountInHostCurrency") <= 2500    THEN 2
            WHEN abs(t."amountInHostCurrency") <= 5000    THEN 3
            WHEN abs(t."amountInHostCurrency") <= 7500    THEN 4
            WHEN abs(t."amountInHostCurrency") <= 10000   THEN 5
            WHEN abs(t."amountInHostCurrency") <= 15000   THEN 6
            WHEN abs(t."amountInHostCurrency") <= 20000   THEN 7
            WHEN abs(t."amountInHostCurrency") <= 25000   THEN 8
            WHEN abs(t."amountInHostCurrency") <= 50000   THEN 9
            WHEN abs(t."amountInHostCurrency") <= 100000  THEN 10
            WHEN abs(t."amountInHostCurrency") <= 200000  THEN 11
            WHEN abs(t."amountInHostCurrency") <= 500000  THEN 12
            WHEN abs(t."amountInHostCurrency") <= 1000000 THEN 13
            WHEN abs(t."amountInHostCurrency") <= 2500000 THEN 14
            WHEN abs(t."amountInHostCurrency") <= 5000000 THEN 15
            ELSE 16
          END AS "amountBandIndex",
          CASE
            WHEN abs(t."amountInHostCurrency") <= 500     THEN '0 – 5'
            WHEN abs(t."amountInHostCurrency") <= 1000    THEN '5 – 10'
            WHEN abs(t."amountInHostCurrency") <= 2500    THEN '10 – 25'
            WHEN abs(t."amountInHostCurrency") <= 5000    THEN '25 – 50'
            WHEN abs(t."amountInHostCurrency") <= 7500    THEN '50 – 75'
            WHEN abs(t."amountInHostCurrency") <= 10000   THEN '75 – 100'
            WHEN abs(t."amountInHostCurrency") <= 15000   THEN '100 – 150'
            WHEN abs(t."amountInHostCurrency") <= 20000   THEN '150 – 200'
            WHEN abs(t."amountInHostCurrency") <= 25000   THEN '200 – 250'
            WHEN abs(t."amountInHostCurrency") <= 50000   THEN '250 – 500'
            WHEN abs(t."amountInHostCurrency") <= 100000  THEN '500 – 1k'
            WHEN abs(t."amountInHostCurrency") <= 200000  THEN '1k – 2k'
            WHEN abs(t."amountInHostCurrency") <= 500000  THEN '2k – 5k'
            WHEN abs(t."amountInHostCurrency") <= 1000000 THEN '5k – 10k'
            WHEN abs(t."amountInHostCurrency") <= 2500000 THEN '10k – 25k'
            WHEN abs(t."amountInHostCurrency") <= 5000000 THEN '25k – 50k'
            ELSE '> 50k'
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
            WHEN abs(t."amountInHostCurrency") <= 500     THEN 0
            WHEN abs(t."amountInHostCurrency") <= 1000    THEN 1
            WHEN abs(t."amountInHostCurrency") <= 2500    THEN 2
            WHEN abs(t."amountInHostCurrency") <= 5000    THEN 3
            WHEN abs(t."amountInHostCurrency") <= 7500    THEN 4
            WHEN abs(t."amountInHostCurrency") <= 10000   THEN 5
            WHEN abs(t."amountInHostCurrency") <= 15000   THEN 6
            WHEN abs(t."amountInHostCurrency") <= 20000   THEN 7
            WHEN abs(t."amountInHostCurrency") <= 25000   THEN 8
            WHEN abs(t."amountInHostCurrency") <= 50000   THEN 9
            WHEN abs(t."amountInHostCurrency") <= 100000  THEN 10
            WHEN abs(t."amountInHostCurrency") <= 200000  THEN 11
            WHEN abs(t."amountInHostCurrency") <= 500000  THEN 12
            WHEN abs(t."amountInHostCurrency") <= 1000000 THEN 13
            WHEN abs(t."amountInHostCurrency") <= 2500000 THEN 14
            WHEN abs(t."amountInHostCurrency") <= 5000000 THEN 15
            ELSE 16
          END,
          CASE
            WHEN abs(t."amountInHostCurrency") <= 500     THEN '0 – 5'
            WHEN abs(t."amountInHostCurrency") <= 1000    THEN '5 – 10'
            WHEN abs(t."amountInHostCurrency") <= 2500    THEN '10 – 25'
            WHEN abs(t."amountInHostCurrency") <= 5000    THEN '25 – 50'
            WHEN abs(t."amountInHostCurrency") <= 7500    THEN '50 – 75'
            WHEN abs(t."amountInHostCurrency") <= 10000   THEN '75 – 100'
            WHEN abs(t."amountInHostCurrency") <= 15000   THEN '100 – 150'
            WHEN abs(t."amountInHostCurrency") <= 20000   THEN '150 – 200'
            WHEN abs(t."amountInHostCurrency") <= 25000   THEN '200 – 250'
            WHEN abs(t."amountInHostCurrency") <= 50000   THEN '250 – 500'
            WHEN abs(t."amountInHostCurrency") <= 100000  THEN '500 – 1k'
            WHEN abs(t."amountInHostCurrency") <= 200000  THEN '1k – 2k'
            WHEN abs(t."amountInHostCurrency") <= 500000  THEN '2k – 5k'
            WHEN abs(t."amountInHostCurrency") <= 1000000 THEN '5k – 10k'
            WHEN abs(t."amountInHostCurrency") <= 2500000 THEN '10k – 25k'
            WHEN abs(t."amountInHostCurrency") <= 5000000 THEN '25k – 50k'
            ELSE '> 50k'
          END
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "hosted_collectives_daily_transaction_sizes__unique_index"
        ON "HostedCollectivesDailyTransactionSizes" ("HostCollectiveId", "CollectiveId", "day", "kindClass", "contributionFrequency", "amountBandIndex");
      CREATE INDEX IF NOT EXISTS "hosted_collectives_daily_transaction_sizes__host_day"
        ON "HostedCollectivesDailyTransactionSizes" ("HostCollectiveId", "day")
        INCLUDE ("CollectiveId", "ParentCollectiveId", "kindClass", "contributionFrequency", "amountBandIndex", "amountBand", "transactionCount", "amount");
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "HostedCollectivesDailyTransactionSizes";`);
  },
};
