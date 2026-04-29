'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "HostedCollectivesDailyFinancialActivity";`);
    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW "HostedCollectivesDailyFinancialActivity" AS (
        SELECT
          (t."createdAt" AT TIME ZONE 'UTC')::date AS "day",
          t."HostCollectiveId",
          t."CollectiveId",
          c."ParentCollectiveId",
          c.type AS "collectiveType",
          COALESCE(p.type, c.type) AS "mainAccountType",
          h.currency AS "hostCurrency",
          (
            COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (
              WHERE t.type = 'CREDIT' AND t.kind = ANY('{CONTRIBUTION,ADDED_FUNDS}'::"enum_Transactions_kind"[]) AND NOT t."isRefund"
            ), 0)
            - COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (
              WHERE t.type = 'DEBIT' AND t.kind = ANY('{CONTRIBUTION,ADDED_FUNDS}'::"enum_Transactions_kind"[]) AND t."isRefund"
            ), 0)
          ) AS "incomeAmount",
          (
            COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (
              WHERE t.type = 'DEBIT' AND t.kind = 'EXPENSE' AND NOT t."isRefund"
            ), 0)
            - COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (
              WHERE t.type = 'CREDIT' AND t.kind = 'EXPENSE' AND t."isRefund"
            ), 0)
          ) AS "spendingAmount",
          COUNT(*) AS "transactionCount"
        FROM "Transactions" t
          INNER JOIN "Collectives" h ON t."HostCollectiveId" = h.id
          INNER JOIN "Collectives" c ON t."CollectiveId" = c.id
          LEFT  JOIN "Collectives" p ON p.id = c."ParentCollectiveId"
        WHERE t."deletedAt" IS NULL
          AND t."HostCollectiveId" IS NOT NULL
          AND t."hostCurrency" = h.currency
          AND COALESCE(c."ParentCollectiveId", c.id) != t."HostCollectiveId"
        GROUP BY
          (t."createdAt" AT TIME ZONE 'UTC')::date,
          t."HostCollectiveId",
          t."CollectiveId",
          c."ParentCollectiveId",
          c.type,
          p.type,
          h.currency
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "hosted_collectives_daily_financial_activity__unique_index"
        ON "HostedCollectivesDailyFinancialActivity" ("HostCollectiveId", "CollectiveId", "day");
      CREATE INDEX IF NOT EXISTS "hosted_collectives_daily_financial_activity__host_day"
        ON "HostedCollectivesDailyFinancialActivity" ("HostCollectiveId", "day")
        INCLUDE ("CollectiveId", "ParentCollectiveId", "collectiveType", "mainAccountType", "incomeAmount", "spendingAmount");
      CREATE INDEX IF NOT EXISTS "hosted_collectives_daily_financial_activity__host_collective"
        ON "HostedCollectivesDailyFinancialActivity" ("HostCollectiveId", "CollectiveId")
        INCLUDE ("day", "collectiveType", "mainAccountType", "incomeAmount", "spendingAmount");
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "HostedCollectivesDailyFinancialActivity";`);
  },
};
