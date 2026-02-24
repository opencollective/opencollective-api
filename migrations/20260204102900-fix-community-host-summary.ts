'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CommunityHostTransactionsAggregated";`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityHostTransactionSummary";`);
    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW "CommunityHostTransactionSummary" as (
        WITH
          anual AS (
            SELECT
              t."FromCollectiveId", t."HostCollectiveId", EXTRACT('YEAR' FROM t."createdAt") AS "year", h.currency AS "hostCurrency",
              COALESCE(SUM(t."amountInHostCurrency") FILTER ( WHERE t.kind = 'EXPENSE' ), 0) AS "expenseTotal",
              COALESCE(COUNT(t."id") FILTER ( WHERE t.kind = 'EXPENSE' ), 0) AS "expenseCount",
              COALESCE(SUM(t."amountInHostCurrency") FILTER ( WHERE t.kind = ANY('{CONTRIBUTION,ADDED_FUNDS}'::"enum_Transactions_kind"[]) ), 0) AS "contributionTotal",
              COALESCE(COUNT(t."id") FILTER ( WHERE t.kind = ANY('{CONTRIBUTION,ADDED_FUNDS}'::"enum_Transactions_kind"[]) ), 0) AS "contributionCount",
              COALESCE(COUNT(DISTINCT (t."OrderId")) FILTER ( WHERE t.kind = ANY('{CONTRIBUTION,ADDED_FUNDS}'::"enum_Transactions_kind"[]) ), 0) AS "orderCount"
            FROM
              "Transactions" t
              INNER JOIN public."Collectives" h ON t."HostCollectiveId" = h.id
              INNER JOIN public."Collectives" c ON t."FromCollectiveId" = c.id
            WHERE t."deletedAt" IS NULL
              AND t."RefundTransactionId" IS NULL
              AND t."isRefund" = FALSE
              AND t.kind = ANY('{CONTRIBUTION,ADDED_FUNDS,EXPENSE}'::"enum_Transactions_kind"[])
              AND t."hostCurrency" = h.currency
            GROUP BY t."FromCollectiveId", t."HostCollectiveId", "year", h.currency
            ORDER BY t."FromCollectiveId", t."HostCollectiveId", "year" DESC
            )
        SELECT
          *, SUM("expenseTotal") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "hostCurrency" ORDER BY "year") AS "expenseTotalAcc",
          SUM("expenseCount") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "hostCurrency" ORDER BY "year") AS "expenseCountAcc",
          SUM("contributionTotal") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "hostCurrency" ORDER BY "year") AS "contributionTotalAcc",
          SUM("contributionCount") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "hostCurrency" ORDER BY "year") AS "contributionCountAcc",
          SUM("orderCount") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "hostCurrency" ORDER BY "year") AS "orderCountAcc"
        FROM anual
      );
    `);
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "community_host_transaction_summary__unique_index" ON "CommunityHostTransactionSummary"("HostCollectiveId", "FromCollectiveId", "year");
      CREATE INDEX IF NOT EXISTS "community_host_transaction_summary__combined_collective_ids" ON "CommunityHostTransactionSummary"("HostCollectiveId", "FromCollectiveId");
      CREATE INDEX IF NOT EXISTS "community_host_transaction_summary__host_collective_id" ON "CommunityHostTransactionSummary" ("HostCollectiveId");
      CREATE INDEX IF NOT EXISTS "community_host_transaction_summary__from_collective_id" ON "CommunityHostTransactionSummary" ("FromCollectiveId");
    `);

    await queryInterface.sequelize.query(`
        CREATE OR REPLACE VIEW "CommunityHostTransactionsAggregated"
          ("FromCollectiveId", "HostCollectiveId", "hostCurrency", "years", "expenseTotal", "expenseCount", "contributionTotal", "contributionCount", "expenseTotalAcc", "expenseCountAcc", "contributionTotalAcc", "contributionCountAcc") AS
        SELECT
          "FromCollectiveId", "HostCollectiveId", "hostCurrency"
          , ARRAY_AGG(year ORDER BY year ASC) AS "years"
          , ARRAY_AGG("expenseTotal" ORDER BY year ASC) AS "expenseTotal"
          , ARRAY_AGG("expenseCount" ORDER BY year ASC) AS "expenseCount"
          , ARRAY_AGG("contributionTotal" ORDER BY year ASC) AS "contributionTotal"
          , ARRAY_AGG("contributionCount" ORDER BY year ASC) AS "contributionCount"
          , ARRAY_AGG("expenseTotalAcc" ORDER BY year ASC) AS "expenseTotalAcc"
          , ARRAY_AGG("expenseCountAcc" ORDER BY year ASC) AS "expenseCountAcc"
          , ARRAY_AGG("contributionTotalAcc" ORDER BY year ASC) AS "contributionTotalAcc"
          , ARRAY_AGG("contributionCountAcc" ORDER BY year ASC) AS "contributionCountAcc"
        FROM "CommunityHostTransactionSummary" cht
        GROUP BY
          "FromCollectiveId", "HostCollectiveId", "hostCurrency";
        `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CommunityHostTransactionsAggregated";`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityHostTransactionSummary";`);
    await queryInterface.sequelize.query(`
          CREATE MATERIALIZED VIEW "CommunityHostTransactionSummary" as (
            WITH
              anual AS
                (
                  SELECT
                    t."FromCollectiveId",
                    t."HostCollectiveId",
                    EXTRACT('YEAR'
                            FROM t."createdAt") AS "year", h.currency AS "hostCurrency",
                    COALESCE(SUM(t."amountInHostCurrency")
                            FILTER (
                              WHERE t.kind = 'EXPENSE' ), 0) AS "expenseTotal",
                    COALESCE(COUNT(t."id") FILTER (
                      WHERE t.kind = 'EXPENSE' ), 0) AS "expenseCount",
                    COALESCE(SUM(t."amountInHostCurrency") FILTER (
                      WHERE t.kind = 'CONTRIBUTION' ), 0) AS "contributionTotal",
                    COALESCE(COUNT(t."id") FILTER (
                      WHERE t.kind = 'CONTRIBUTION' ), 0) AS "contributionCount",
                    COALESCE(COUNT(DISTINCT(t."OrderId")) FILTER (
                      WHERE t.kind = 'CONTRIBUTION' ), 0) AS "orderCount"
                  FROM
                    "Transactions" t
                    INNER JOIN public."Collectives" h ON t."HostCollectiveId" = h.id
                    INNER JOIN public."Collectives" c ON t."FromCollectiveId" = c.id
                  WHERE t."deletedAt" IS NULL
                    AND t."RefundTransactionId" IS NULL
                    AND t."isRefund" = FALSE
                    AND t.kind IN ('CONTRIBUTION', 'EXPENSE')
                    AND t."hostCurrency" = h.currency
                  GROUP BY t."FromCollectiveId", t."HostCollectiveId", "year", h.currency
                  ORDER BY t."FromCollectiveId", t."HostCollectiveId", "year" DESC
                  )
            SELECT
              *,
              SUM("expenseTotal")
                OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "hostCurrency" ORDER BY "year") AS "expenseTotalAcc",
              SUM("expenseCount")
                OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "hostCurrency" ORDER BY "year") AS "expenseCountAcc",
              SUM("contributionTotal")
                OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "hostCurrency" ORDER BY "year") AS "contributionTotalAcc",
              SUM("contributionCount")
                OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "hostCurrency" ORDER BY "year") AS "contributionCountAcc",
              SUM("orderCount")
                OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "hostCurrency" ORDER BY "year") AS "orderCountAcc"
            FROM anual
          );
        `);
    await queryInterface.sequelize.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS "community_host_transaction_summary__unique_index" ON "CommunityHostTransactionSummary"("HostCollectiveId", "FromCollectiveId", "year");
          CREATE INDEX IF NOT EXISTS "community_host_transaction_summary__combined_collective_ids" ON "CommunityHostTransactionSummary"("HostCollectiveId", "FromCollectiveId");
          CREATE INDEX IF NOT EXISTS "community_host_transaction_summary__host_collective_id" ON "CommunityHostTransactionSummary" ("HostCollectiveId");
          CREATE INDEX IF NOT EXISTS "community_host_transaction_summary__from_collective_id" ON "CommunityHostTransactionSummary" ("FromCollectiveId");
        `);
    await queryInterface.sequelize.query(`
           CREATE OR REPLACE VIEW "CommunityHostTransactionsAggregated"
             ("FromCollectiveId", "HostCollectiveId", "hostCurrency", "years", "expenseTotal", "expenseCount", "contributionTotal", "contributionCount", "expenseTotalAcc", "expenseCountAcc", "contributionTotalAcc", "contributionCountAcc") AS
           SELECT
             "FromCollectiveId", "HostCollectiveId", "hostCurrency"
             , ARRAY_AGG(year ORDER BY year ASC) AS "years"
             , ARRAY_AGG("expenseTotal" ORDER BY year ASC) AS "expenseTotal"
             , ARRAY_AGG("expenseCount" ORDER BY year ASC) AS "expenseCount"
             , ARRAY_AGG("contributionTotal" ORDER BY year ASC) AS "contributionTotal"
             , ARRAY_AGG("contributionCount" ORDER BY year ASC) AS "contributionCount"
             , ARRAY_AGG("expenseTotalAcc" ORDER BY year ASC) AS "expenseTotalAcc"
             , ARRAY_AGG("expenseCountAcc" ORDER BY year ASC) AS "expenseCountAcc"
             , ARRAY_AGG("contributionTotalAcc" ORDER BY year ASC) AS "contributionTotalAcc"
             , ARRAY_AGG("contributionCountAcc" ORDER BY year ASC) AS "contributionCountAcc"
           FROM "CommunityHostTransactionSummary" cht
           GROUP BY
             "FromCollectiveId", "HostCollectiveId", "hostCurrency";
           `);
  },
};
