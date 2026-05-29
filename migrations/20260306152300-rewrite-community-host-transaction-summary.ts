'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CommunityHostTransactionsAggregated";`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityHostTransactionSummary";`);
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CommunityHostTransactionSummary";`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityHostYearlyTransactionSummary";`);
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CommunityHostYearlyTransactionSummary";`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityTransactionSummary";`);
    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW "CommunityTransactionSummary" as (
        WITH
          anual AS (
            SELECT
              t."FromCollectiveId", t."CollectiveId", t."HostCollectiveId", EXTRACT('YEAR' FROM t."createdAt") AS "year", t.kind, h.currency AS "hostCurrency",
              COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (WHERE t.type = 'DEBIT'), 0) AS "debitTotal", COALESCE(COUNT(t."id") FILTER ( WHERE t.type = 'DEBIT' ), 0) AS "debitCount",
              COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (WHERE t.type = 'CREDIT'), 0) AS "creditTotal", COALESCE(COUNT(t."id") FILTER ( WHERE t.type = 'CREDIT'), 0) AS "creditCount",
              COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (WHERE t.type = 'CREDIT' AND t."isRefund"), 0) AS "refundDebitTotal",
              COALESCE(COUNT(t."id") FILTER (WHERE t.type = 'CREDIT' AND t."isRefund"), 0) AS "refundDebitCount"
            FROM
              "Transactions" t
              INNER JOIN public."Collectives" h ON t."HostCollectiveId" = h.id
              INNER JOIN public."Collectives" c ON t."FromCollectiveId" = c.id
            WHERE t."deletedAt" IS NULL
              AND t."hostCurrency" = h.currency
            GROUP BY t."FromCollectiveId", t."CollectiveId", t."HostCollectiveId", "year", h.currency, t.kind
            ORDER BY t."FromCollectiveId", t."CollectiveId", t."HostCollectiveId", t.kind, "year" DESC
            )
        SELECT
          *, SUM("debitTotal") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY "year") AS "debitTotalAcc",
          SUM("debitCount") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY "year") AS "debitCountAcc",
          SUM("creditTotal") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY "year") AS "creditTotalAcc",
          SUM("creditCount") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY "year") AS "creditCountAcc",
          SUM("refundDebitTotal") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY "year") AS "refundDebitTotalAcc",
          SUM("refundDebitCount") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY "year") AS "refundDebitCountAcc"
        FROM anual
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "community_transaction_summary__unique_index" ON "CommunityTransactionSummary"("HostCollectiveId", "FromCollectiveId", "CollectiveId", "year", "kind");
      CREATE INDEX IF NOT EXISTS "community_transaction_summary__combined_collective_ids" ON "CommunityTransactionSummary"("HostCollectiveId", "FromCollectiveId", "CollectiveId") INCLUDE ("kind", "year", "creditTotalAcc", "debitTotalAcc");
      CREATE INDEX IF NOT EXISTS "community_transaction_summary__host_collective_id" ON "CommunityTransactionSummary" ("HostCollectiveId") INCLUDE ("kind", "year", "creditTotalAcc", "debitTotalAcc");
      CREATE INDEX IF NOT EXISTS "community_transaction_summary__from_collective_id" ON "CommunityTransactionSummary" ("FromCollectiveId") INCLUDE ("kind", "year", "creditTotalAcc", "debitTotalAcc");
      CREATE INDEX IF NOT EXISTS "community_transaction_summary__collective_id" ON "CommunityTransactionSummary" ("CollectiveId") INCLUDE ("kind", "year", "creditTotalAcc", "debitTotalAcc");
    `);

    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW "CommunityHostYearlyTransactionSummary"
        ("FromCollectiveId", "HostCollectiveId", "hostCurrency", "year", "kind", "debitTotal", "debitCount", "creditTotal", "creditCount", "refundDebitTotal", "refundDebitCount") AS
      WITH summary AS (
        SELECT
          "FromCollectiveId", "HostCollectiveId", "hostCurrency", "year", "kind",
          SUM("debitTotal") AS "debitTotal", SUM("debitCount") AS "debitCount",
          SUM("creditTotal") AS "creditTotal", SUM("creditCount") AS "creditCount",
          SUM("refundDebitTotal") AS "refundDebitTotal", SUM("refundDebitCount") AS "refundDebitCount"
        FROM "CommunityTransactionSummary"
        GROUP BY "FromCollectiveId", "HostCollectiveId", "hostCurrency", "year", "kind"
      )
      SELECT "FromCollectiveId", "HostCollectiveId", "hostCurrency", "year", "kind", "debitTotal", "debitCount", "creditTotal", "creditCount", "refundDebitTotal", "refundDebitCount"
      FROM summary
      UNION ALL
      SELECT
        "FromCollectiveId", "HostCollectiveId", "hostCurrency", "year", null AS "kind",
        SUM("debitTotal"), SUM("debitCount"), SUM("creditTotal"), SUM("creditCount"),
        SUM("refundDebitTotal"), SUM("refundDebitCount")
      FROM summary
      GROUP BY "FromCollectiveId", "HostCollectiveId", "hostCurrency", "year"
      ORDER BY "FromCollectiveId", "HostCollectiveId", "year" DESC;
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "community_host_yearly_transaction_summary__unique_index" ON "CommunityHostYearlyTransactionSummary"("HostCollectiveId", "FromCollectiveId", "hostCurrency", "year", "kind");
      CREATE INDEX IF NOT EXISTS "community_host_yearly_transaction_summary__combined_collective_ids" ON "CommunityHostYearlyTransactionSummary"("HostCollectiveId", "FromCollectiveId") INCLUDE ("kind", "year", "creditTotal", "debitTotal");
      CREATE INDEX IF NOT EXISTS "community_host_yearly_transaction_summary__host_collective_id" ON "CommunityHostYearlyTransactionSummary" ("HostCollectiveId") INCLUDE ("kind", "year", "creditTotal", "debitTotal");
      CREATE INDEX IF NOT EXISTS "community_host_yearly_transaction_summary__from_collective_id" ON "CommunityHostYearlyTransactionSummary" ("FromCollectiveId") INCLUDE ("kind", "year", "creditTotal", "debitTotal");
    `);

    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW "CommunityHostTransactionSummary"
        ("FromCollectiveId", "HostCollectiveId", "hostCurrency", "kind", "debitTotal", "debitCount", "creditTotal", "creditCount", "refundDebitTotal", "refundDebitCount") AS
      WITH summary AS (
        SELECT
          "FromCollectiveId", "HostCollectiveId", "hostCurrency", "kind",
          SUM("debitTotal") AS "debitTotal", SUM("debitCount") AS "debitCount",
          SUM("creditTotal") AS "creditTotal", SUM("creditCount") AS "creditCount",
          SUM("refundDebitTotal") AS "refundDebitTotal", SUM("refundDebitCount") AS "refundDebitCount"
        FROM "CommunityTransactionSummary"
        GROUP BY "FromCollectiveId", "HostCollectiveId", "hostCurrency", "kind"
      )
      SELECT "FromCollectiveId", "HostCollectiveId", "hostCurrency", "kind", "debitTotal", "debitCount", "creditTotal", "creditCount", "refundDebitTotal", "refundDebitCount"
      FROM summary
      UNION ALL
      SELECT
        "FromCollectiveId", "HostCollectiveId", "hostCurrency", null AS "kind",
        SUM("debitTotal"), SUM("debitCount"), SUM("creditTotal"), SUM("creditCount"),
        SUM("refundDebitTotal"), SUM("refundDebitCount")
      FROM summary
      GROUP BY "FromCollectiveId", "HostCollectiveId", "hostCurrency"
      ORDER BY "FromCollectiveId", "HostCollectiveId";
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "community_host_transaction_summary__unique_index" ON "CommunityHostTransactionSummary"("HostCollectiveId", "FromCollectiveId", "hostCurrency", "kind");
      CREATE INDEX IF NOT EXISTS "community_host_transaction_summary__combined_collective_ids" ON "CommunityHostTransactionSummary"("HostCollectiveId", "FromCollectiveId") INCLUDE ("kind", "creditTotal", "debitTotal");
      CREATE INDEX IF NOT EXISTS "community_host_transaction_summary__host_collective_id" ON "CommunityHostTransactionSummary" ("HostCollectiveId") INCLUDE ("kind", "creditTotal", "debitTotal");
      CREATE INDEX IF NOT EXISTS "community_host_transaction_summary__from_collective_id" ON "CommunityHostTransactionSummary" ("FromCollectiveId") INCLUDE ("kind", "creditTotal", "debitTotal");
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityHostYearlyTransactionSummary";`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityHostTransactionSummary";`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityTransactionSummary";`);
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
};
