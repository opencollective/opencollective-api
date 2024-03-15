'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
    CREATE MATERIALIZED VIEW "HostMonthlyTransactions" AS
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
    ORDER BY "date", t."HostCollectiveId", t."kind";
  `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "host_monthly_transactions__host_collective_id" ON "HostMonthlyTransactions"("HostCollectiveId");
    `);

    // Add index on (id, type) for Expenses to speed up the join with Transactions, used in GraphQL resolver `host.transactionsReports`
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "expenses__id_type" ON "Expenses"("id", "type");
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "host_monthly_transactions__host_collective_id";
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "expenses__id_type";
    `);
    await queryInterface.sequelize.query(`
      DROP MATERIALIZED VIEW "HostMonthlyTransactions";
    `);
  },
};
