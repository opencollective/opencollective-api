'use strict';

/** @type {import('sequelize-cli').Migration} */

const dropViews = async (queryInterface, transaction) => {
  await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "AdminCommunityHostTransactionSummary";`, {
    transaction,
  });
  await queryInterface.sequelize.query(
    `DROP MATERIALIZED VIEW IF EXISTS "AdminCommunityHostYearlyTransactionSummary";`,
    { transaction },
  );
  await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "AdminCommunityTransactionSummary";`, {
    transaction,
  });
};

const createTransactionSummary = async (queryInterface, summaryQuery, transaction) => {
  await queryInterface.sequelize.query(
    `CREATE MATERIALIZED VIEW "AdminCommunityTransactionSummary" AS (
    ${summaryQuery}
  );`,
    { transaction },
  );

  await queryInterface.sequelize.query(
    `
    CREATE UNIQUE INDEX "admin_community_transaction_summary__unique_index"
      ON "AdminCommunityTransactionSummary"("HostCollectiveId", "FromCollectiveId", "CollectiveId", "year", "kind");
    CREATE INDEX "admin_community_transaction_summary__combined_collective_ids"
      ON "AdminCommunityTransactionSummary"("HostCollectiveId", "FromCollectiveId", "CollectiveId")
      INCLUDE ("kind", "year", "creditTotalAcc", "debitTotalAcc");
    CREATE INDEX "admin_community_transaction_summary__host_collective_id"
      ON "AdminCommunityTransactionSummary" ("HostCollectiveId")
      INCLUDE ("kind", "year", "creditTotalAcc", "debitTotalAcc");
    CREATE INDEX "admin_community_transaction_summary__from_collective_id"
      ON "AdminCommunityTransactionSummary" ("FromCollectiveId")
      INCLUDE ("kind", "year", "creditTotalAcc", "debitTotalAcc");
    CREATE INDEX "admin_community_transaction_summary__collective_id"
      ON "AdminCommunityTransactionSummary" ("CollectiveId")
      INCLUDE ("kind", "year", "creditTotalAcc", "debitTotalAcc");
  `,
    { transaction },
  );
};

const createDependentViews = async (queryInterface, transaction) => {
  await queryInterface.sequelize.query(
    `
    CREATE MATERIALIZED VIEW "AdminCommunityHostYearlyTransactionSummary"
      ("FromCollectiveId", "HostCollectiveId", "hostCurrency", "year", "kind", "debitTotal", "debitCount", "creditTotal", "creditCount", "refundDebitTotal", "refundDebitCount") AS
    WITH summary AS (
      SELECT
        "FromCollectiveId", "HostCollectiveId", "hostCurrency", "year", "kind",
        SUM("debitTotal") AS "debitTotal", SUM("debitCount") AS "debitCount",
        SUM("creditTotal") AS "creditTotal", SUM("creditCount") AS "creditCount",
        SUM("refundDebitTotal") AS "refundDebitTotal", SUM("refundDebitCount") AS "refundDebitCount"
      FROM "AdminCommunityTransactionSummary"
      GROUP BY "FromCollectiveId", "HostCollectiveId", "hostCurrency", "year", "kind"
    )
    SELECT "FromCollectiveId", "HostCollectiveId", "hostCurrency", "year", "kind", "debitTotal", "debitCount", "creditTotal", "creditCount", "refundDebitTotal", "refundDebitCount"
    FROM summary
    UNION ALL
    SELECT
      "FromCollectiveId", "HostCollectiveId", "hostCurrency", "year", NULL AS "kind",
      SUM("debitTotal"), SUM("debitCount"), SUM("creditTotal"), SUM("creditCount"),
      SUM("refundDebitTotal"), SUM("refundDebitCount")
    FROM summary
    GROUP BY "FromCollectiveId", "HostCollectiveId", "hostCurrency", "year"
    ORDER BY "FromCollectiveId", "HostCollectiveId", "year" DESC;

    CREATE UNIQUE INDEX "admin_community_host_yearly_transaction_summary__unique_index"
      ON "AdminCommunityHostYearlyTransactionSummary"("HostCollectiveId", "FromCollectiveId", "hostCurrency", "year", "kind");
    CREATE INDEX "admin_community_host_yearly_transaction_summary__combined_collective_ids"
      ON "AdminCommunityHostYearlyTransactionSummary"("HostCollectiveId", "FromCollectiveId")
      INCLUDE ("kind", "year", "creditTotal", "debitTotal");
    CREATE INDEX "admin_community_host_yearly_transaction_summary__host_collective_id"
      ON "AdminCommunityHostYearlyTransactionSummary" ("HostCollectiveId")
      INCLUDE ("kind", "year", "creditTotal", "debitTotal");
    CREATE INDEX "admin_community_host_yearly_transaction_summary__from_collective_id"
      ON "AdminCommunityHostYearlyTransactionSummary" ("FromCollectiveId")
      INCLUDE ("kind", "year", "creditTotal", "debitTotal");
  `,
    { transaction },
  );

  await queryInterface.sequelize.query(
    `
    CREATE MATERIALIZED VIEW "AdminCommunityHostTransactionSummary"
      ("FromCollectiveId", "HostCollectiveId", "hostCurrency", "kind", "debitTotal", "debitCount", "creditTotal", "creditCount", "refundDebitTotal", "refundDebitCount") AS
    WITH summary AS (
      SELECT
        "FromCollectiveId", "HostCollectiveId", "hostCurrency", "kind",
        SUM("debitTotal") AS "debitTotal", SUM("debitCount") AS "debitCount",
        SUM("creditTotal") AS "creditTotal", SUM("creditCount") AS "creditCount",
        SUM("refundDebitTotal") AS "refundDebitTotal", SUM("refundDebitCount") AS "refundDebitCount"
      FROM "AdminCommunityTransactionSummary"
      GROUP BY "FromCollectiveId", "HostCollectiveId", "hostCurrency", "kind"
    )
    SELECT "FromCollectiveId", "HostCollectiveId", "hostCurrency", "kind", "debitTotal", "debitCount", "creditTotal", "creditCount", "refundDebitTotal", "refundDebitCount"
    FROM summary
    UNION ALL
    SELECT
      "FromCollectiveId", "HostCollectiveId", "hostCurrency", NULL AS "kind",
      SUM("debitTotal"), SUM("debitCount"), SUM("creditTotal"), SUM("creditCount"),
      SUM("refundDebitTotal"), SUM("refundDebitCount")
    FROM summary
    GROUP BY "FromCollectiveId", "HostCollectiveId", "hostCurrency"
    ORDER BY "FromCollectiveId", "HostCollectiveId";

    CREATE UNIQUE INDEX "admin_community_host_transaction_summary__unique_index"
      ON "AdminCommunityHostTransactionSummary"("HostCollectiveId", "FromCollectiveId", "hostCurrency", "kind");
    CREATE INDEX "admin_community_host_transaction_summary__combined_collective_ids"
      ON "AdminCommunityHostTransactionSummary"("HostCollectiveId", "FromCollectiveId")
      INCLUDE ("kind", "creditTotal", "debitTotal");
    CREATE INDEX "admin_community_host_transaction_summary__host_collective_id"
      ON "AdminCommunityHostTransactionSummary" ("HostCollectiveId")
      INCLUDE ("kind", "creditTotal", "debitTotal");
    CREATE INDEX "admin_community_host_transaction_summary__from_collective_id"
      ON "AdminCommunityHostTransactionSummary" ("FromCollectiveId")
      INCLUDE ("kind", "creditTotal", "debitTotal");
  `,
    { transaction },
  );
};

const optimizedSummaryQuery = `
  WITH
    anual AS (
      SELECT
        COALESCE(((c.data #> '{UserCollectiveId}')::integer), c.id) AS "FromCollectiveId", t."CollectiveId", t."HostCollectiveId", EXTRACT(YEAR FROM t."createdAt") AS year, t.kind,
        h.currency AS "hostCurrency", COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (WHERE ((t.type) = 'DEBIT')), (0)) AS "debitTotal",
        COALESCE(COUNT(t.id) FILTER (WHERE ((t.type) = 'DEBIT')), (0)) AS "debitCount",
        COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (WHERE ((t.type) = 'CREDIT')), (0)) AS "creditTotal",
        COALESCE(COUNT(t.id) FILTER (WHERE ((t.type) = 'CREDIT')), (0)) AS "creditCount",
        COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (WHERE (((t.type) = 'CREDIT') AND t."isRefund")), (0)) AS "refundDebitTotal",
        COALESCE(COUNT(t.id) FILTER (WHERE (((t.type) = 'CREDIT') AND t."isRefund")), (0)) AS "refundDebitCount"
      FROM
        "Transactions" t
        INNER JOIN "Collectives" h ON t."HostCollectiveId" = h.id AND h."deletedAt" IS NULL AND h."hasMoneyManagement" IS TRUE
        INNER JOIN "Collectives" c ON t."FromCollectiveId" = c.id AND c."deletedAt" IS NULL
      WHERE t."deletedAt" IS NULL
        AND t."hostCurrency" = h.currency
      GROUP BY COALESCE(((c.data #> '{UserCollectiveId}')::integer), c.id), t."CollectiveId", t."HostCollectiveId", (EXTRACT(YEAR FROM t."createdAt")), h.currency, t.kind
      ORDER BY COALESCE(((c.data #> '{UserCollectiveId}')::integer), c.id), t."CollectiveId", t."HostCollectiveId", t.kind, (EXTRACT(YEAR FROM t."createdAt")) DESC
    )
  SELECT
    "FromCollectiveId", "CollectiveId", "HostCollectiveId", year, kind, "hostCurrency", "debitTotal", "debitCount", "creditTotal", "creditCount", "refundDebitTotal",
    "refundDebitCount", SUM("debitTotal") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "debitTotalAcc",
    SUM("debitCount") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "debitCountAcc",
    SUM("creditTotal") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "creditTotalAcc",
    SUM("creditCount") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "creditCountAcc",
    SUM("refundDebitTotal") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "refundDebitTotalAcc",
    SUM("refundDebitCount") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "refundDebitCountAcc"
  FROM anual`;

const previousSummaryQuery = `
  WITH anual AS (
    SELECT
      COALESCE((c.data #> '{UserCollectiveId}')::INTEGER, c.id) AS "FromCollectiveId", t."CollectiveId", t."HostCollectiveId", EXTRACT(YEAR FROM t."createdAt") AS year, t.kind, h.currency AS "hostCurrency",
      COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (WHERE t.type::text = 'DEBIT'::text), 0::bigint) AS "debitTotal",
      COALESCE(COUNT(t.id) FILTER (WHERE t.type::text = 'DEBIT'::text), 0::bigint) AS "debitCount",
      COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (WHERE t.type::text = 'CREDIT'::text), 0::bigint) AS "creditTotal",
      COALESCE(COUNT(t.id) FILTER (WHERE t.type::text = 'CREDIT'::text), 0::bigint) AS "creditCount",
      COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (WHERE t.type::text = 'CREDIT'::text AND t."isRefund"), 0::bigint) AS "refundDebitTotal",
      COALESCE(COUNT(t.id) FILTER (WHERE t.type::text = 'CREDIT'::text AND t."isRefund"), 0::bigint) AS "refundDebitCount"
    FROM "Transactions" t
      JOIN "Collectives" h ON t."HostCollectiveId" = h.id
      JOIN "Collectives" c ON t."FromCollectiveId" = c.id
    WHERE t."deletedAt" IS NULL AND t."hostCurrency"::text = h.currency::text
    GROUP BY COALESCE((c.data #> '{UserCollectiveId}')::INTEGER, c.id), t."CollectiveId", t."HostCollectiveId", EXTRACT(YEAR FROM t."createdAt"), h.currency, t.kind
    ORDER BY COALESCE((c.data #> '{UserCollectiveId}')::INTEGER, c.id), t."CollectiveId", t."HostCollectiveId", t.kind, EXTRACT(YEAR FROM t."createdAt") DESC
  )
  SELECT
    "FromCollectiveId", "CollectiveId", "HostCollectiveId", year, kind, "hostCurrency", "debitTotal", "debitCount", "creditTotal", "creditCount", "refundDebitTotal", "refundDebitCount",
    SUM("debitTotal") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "debitTotalAcc",
    SUM("debitCount") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "debitCountAcc",
    SUM("creditTotal") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "creditTotalAcc",
    SUM("creditCount") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "creditCountAcc",
    SUM("refundDebitTotal") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "refundDebitTotalAcc",
    SUM("refundDebitCount") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "refundDebitCountAcc"
  FROM anual`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await dropViews(queryInterface, transaction);
      await createTransactionSummary(queryInterface, optimizedSummaryQuery, transaction);
      await createDependentViews(queryInterface, transaction);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await dropViews(queryInterface, transaction);
      await createTransactionSummary(queryInterface, previousSummaryQuery, transaction);
      await createDependentViews(queryInterface, transaction);
    });
  },
};
