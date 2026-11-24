'use strict';

import type { QueryInterface } from 'sequelize';

/**
 * Speeds up the hourly `REFRESH MATERIALIZED VIEW "HostMonthlyTransactions"` (opencollective/opencollective#9160).
 *
 * The view returns the same rows as before. Only the shape of the query changes:
 * - The `isHost` CASE (with its EXISTS subquery) and `DATE_TRUNC` are computed in a subquery. Grouping directly on them
 *   made Postgres estimate one group per transaction, so it sorted every transaction (spilling ~1.1 GB to disk at
 *   15M transactions) and aggregated them in a single process, as the EXISTS in the grouping key is not parallel safe.
 * - `OFFSET 0` keeps Postgres from flattening the subquery, so the group estimate stays realistic and it picks an
 *   in-memory hash aggregate. At 15M transactions: 9.6s to 5.0s per refresh, no temporary files.
 *
 * Cost: this migration recreates the view `WITH DATA`, which takes as long as one refresh (the hourly cron
 * takes ~3.5 minutes in production today; the new query should take about half). `DROP` holds an ACCESS EXCLUSIVE
 * lock on the view until the migration commits: `Host.hostTransactionsReports` waits during that time, exactly as
 * it does during every hourly refresh. No lock is taken on `Transactions`, `Collectives` or `Expenses` beyond reads.
 */

const NEW_SELECT = `
  SELECT
    t."date",
    t."HostCollectiveId",
    SUM(t."amountInHostCurrency") as "amountInHostCurrency",
    SUM(COALESCE(t."platformFeeInHostCurrency", 0)) as "platformFeeInHostCurrency",
    SUM(COALESCE(t."hostFeeInHostCurrency", 0)) as "hostFeeInHostCurrency",
    SUM(COALESCE(t."paymentProcessorFeeInHostCurrency", 0)) as "paymentProcessorFeeInHostCurrency",
    SUM(COALESCE(t."taxAmount" * COALESCE(t."hostCurrencyFxRate", 1), 0)) as "taxAmountInHostCurrency",
    COALESCE(
      SUM(COALESCE(t."amountInHostCurrency", 0))
      + SUM(COALESCE(t."platformFeeInHostCurrency", 0))
      + SUM(COALESCE(t."hostFeeInHostCurrency", 0))
      + SUM(COALESCE(t."paymentProcessorFeeInHostCurrency", 0))
      + SUM(COALESCE(t."taxAmount" * COALESCE(t."hostCurrencyFxRate", 1), 0)),
      0
    ) AS "netAmountInHostCurrency",
    t."kind",
    t."isRefund",
    t."hostCurrency",
    t."type",
    t."isHost",
    t."expenseType",
    NOW() AS "refreshedAt"
  FROM (
    SELECT
      DATE_TRUNC('month', t."createdAt" AT TIME ZONE 'UTC') as "date",
      t."HostCollectiveId",
      t."amountInHostCurrency",
      t."platformFeeInHostCurrency",
      t."hostFeeInHostCurrency",
      t."paymentProcessorFeeInHostCurrency",
      t."taxAmount",
      t."hostCurrencyFxRate",
      t."kind",
      t."isRefund",
      t."hostCurrency",
      t."type",
      CASE
        WHEN t."CollectiveId" = t."HostCollectiveId" THEN TRUE
        WHEN EXISTS (
          SELECT 1
          FROM "Collectives" c
          WHERE c."id" = t."CollectiveId"
          AND c."ParentCollectiveId" = t."HostCollectiveId"
          AND c."type" != 'VENDOR'
        ) THEN TRUE
        ELSE FALSE
      END AS "isHost",
      e."type" as "expenseType"
    FROM "Transactions" t
    LEFT JOIN LATERAL (
      SELECT e2."type" from "Expenses" e2 where e2.id = t."ExpenseId"
    ) as e ON t."ExpenseId" IS NOT NULL
    WHERE
      t."deletedAt" IS NULL
      AND t."HostCollectiveId" IS NOT NULL
    -- Optimization fence, see the comment at the top of this file
    OFFSET 0
  ) t
  GROUP BY t."date", t."HostCollectiveId", t."kind", t."hostCurrency", t."isRefund", t."type", t."isHost", t."expenseType"
  ORDER BY "date", t."HostCollectiveId", t."kind"
`;

// Definition from migrations/20240325093342-create-host-monthly-transactions-materialized-view.js
const PREVIOUS_SELECT = `
  SELECT
    DATE_TRUNC('month', t."createdAt" AT TIME ZONE 'UTC') as "date",
    t."HostCollectiveId",
    SUM(t."amountInHostCurrency") as "amountInHostCurrency",
    SUM(COALESCE(t."platformFeeInHostCurrency", 0)) as "platformFeeInHostCurrency",
    SUM(COALESCE(t."hostFeeInHostCurrency", 0)) as "hostFeeInHostCurrency",
    SUM(COALESCE(t."paymentProcessorFeeInHostCurrency", 0)) as "paymentProcessorFeeInHostCurrency",
    SUM(COALESCE(t."taxAmount" * COALESCE(t."hostCurrencyFxRate", 1), 0)) as "taxAmountInHostCurrency",
    COALESCE(
      SUM(COALESCE(t."amountInHostCurrency", 0))
      + SUM(COALESCE(t."platformFeeInHostCurrency", 0))
      + SUM(COALESCE(t."hostFeeInHostCurrency", 0))
      + SUM(COALESCE(t."paymentProcessorFeeInHostCurrency", 0))
      + SUM(COALESCE(t."taxAmount" * COALESCE(t."hostCurrencyFxRate", 1), 0)),
      0
    ) AS "netAmountInHostCurrency",
    t."kind",
    t."isRefund",
    t."hostCurrency",
    t."type",
    CASE
      WHEN t."CollectiveId" = t."HostCollectiveId" THEN TRUE
      WHEN EXISTS (
        SELECT 1
        FROM "Collectives" c
        WHERE c."id" = t."CollectiveId"
        AND c."ParentCollectiveId" = t."HostCollectiveId"
        AND c."type" != 'VENDOR'
      ) THEN TRUE
      ELSE FALSE
    END AS "isHost",
    e."type" as "expenseType",
    NOW() AS "refreshedAt"
  FROM "Transactions" t
  LEFT JOIN LATERAL (
    SELECT e2."type" from "Expenses" e2 where e2.id = t."ExpenseId"
  ) as e ON t."ExpenseId" IS NOT NULL
  WHERE
    t."deletedAt" IS NULL
    AND t."HostCollectiveId" IS NOT NULL
  GROUP BY DATE_TRUNC('month', t."createdAt" AT TIME ZONE 'UTC'), t."HostCollectiveId", t."kind", t."hostCurrency", t."isRefund", t."type", "isHost", "expenseType"
  ORDER BY "date", t."HostCollectiveId", t."kind"
`;

const recreateView = async (queryInterface: QueryInterface, select: string) => {
  await queryInterface.sequelize.transaction(async transaction => {
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "HostMonthlyTransactions"`, { transaction });
    await queryInterface.sequelize.query(`CREATE MATERIALIZED VIEW "HostMonthlyTransactions" AS ${select}`, {
      transaction,
    });
    await queryInterface.sequelize.query(
      `CREATE INDEX "host_monthly_transactions__host_collective_id" ON "HostMonthlyTransactions"("HostCollectiveId")`,
      { transaction },
    );
  });
};

module.exports = {
  async up(queryInterface: QueryInterface) {
    await recreateView(queryInterface, NEW_SELECT);
  },

  async down(queryInterface: QueryInterface) {
    await recreateView(queryInterface, PREVIOUS_SELECT);
  },
};
