'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityHostTransactionSummary";`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityHostYearlyTransactionSummary";`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityTransactionSummary";`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityActivitySummary";`);

    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW "CommunityActivitySummary" AS
        WITH
          relevant_activities AS (
            (
              SELECT
                a."HostCollectiveId", NULL::integer AS "UserId", COALESCE((fc.data->'UserCollectiveId')::INTEGER, fc.id) AS "FromCollectiveId", a."CollectiveId", a.type, a."createdAt",
                CASE
                  WHEN a.type::text = ANY (ARRAY ['order.processed'::character varying, 'ticket.confirmed'::character varying]::text[]) THEN 'CONTRIBUTOR'::text
                  WHEN a.type::text = 'collective.expense.paid'::text AND e.type = 'GRANT'::"enum_Expenses_type" THEN 'GRANTEE'::text
                  WHEN a.type::text = 'collective.expense.paid'::text THEN 'PAYEE'::text
                  WHEN a.type::text = 'collective.expense.created'::text THEN 'EXPENSE_SUBMITTER'::text
                  ELSE NULL::text END AS relations
              FROM
                "Activities" a
                LEFT JOIN "Expenses" e ON a.type::text = 'collective.expense.paid'::text AND e.id = a."ExpenseId"
                LEFT JOIN "Collectives" fc ON a."FromCollectiveId" = fc.id
              WHERE a.type::text = ANY
                    (ARRAY ['order.processed'::character varying, 'collective.expense.approved'::character varying, 'collective.expense.paid'::character varying, 'collective.expense.created'::character varying, 'ticket.confirmed'::character varying]::text[])
              UNION ALL
              SELECT
                a."HostCollectiveId", a."UserId", NULL::integer AS "FromCollectiveId", a."CollectiveId", a.type, a."createdAt",
                CASE
                  WHEN a.type::text = ANY (ARRAY ['collective.expense.approved'::character varying, 'collective.expense.rejected'::character varying]::text[]) THEN 'EXPENSE_APPROVER'::text
                  ELSE NULL::text END AS relations
              FROM "Activities" a
              WHERE a.type::text = ANY (ARRAY ['collective.expense.approved'::character varying, 'collective.expense.rejected'::character varying]::text[])
              )
            UNION
            SELECT
              c."HostCollectiveId", (fc.data->'UserId')::INTEGER AS "UserId", COALESCE((fc.data->'UserCollectiveId')::INTEGER, fc.id) AS "FromCollectiveId", c.id AS "CollectiveId", NULL::character varying AS type, m."createdAt",
              CASE WHEN m.role::text = 'BACKER'::text THEN 'CONTRIBUTOR'::character varying ELSE m.role END AS relations
            FROM
              "Members" m
              INNER JOIN "Collectives" c ON m."CollectiveId" = c.id
              INNER JOIN "Collectives" fc ON m."MemberCollectiveId" = fc.id
            WHERE (m.role::text = ANY (ARRAY ['ADMIN'::character varying, 'CONTRIBUTOR'::character varying, 'ATTENDEE'::character varying, 'BACKER'::character varying]::text[]))
              AND m."deletedAt" IS NULL
            )
        SELECT
          ra."HostCollectiveId", ra."CollectiveId", COALESCE(ra."FromCollectiveId", u."CollectiveId") AS "FromCollectiveId", jsonb_agg_strict(DISTINCT ra.type) AS activities,
          jsonb_agg_strict(DISTINCT ra.relations) AS relations, MAX(ra."createdAt") AS "lastInteractionAt", MIN(ra."createdAt") AS "firstInteractionAt"
        FROM
          relevant_activities ra
          LEFT JOIN "Users" u ON u.id = ra."UserId"
        WHERE (ra."UserId" IS NOT NULL OR ra."FromCollectiveId" IS NOT NULL)
          AND ra."HostCollectiveId" IS NOT NULL
          AND ra."CollectiveId" IS NOT NULL
        GROUP BY
          ra."HostCollectiveId", ra."CollectiveId", (COALESCE(ra."FromCollectiveId", u."CollectiveId"));
    `);
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX community_activity_summary__all_collective_ids ON "CommunityActivitySummary" ("HostCollectiveId", "FromCollectiveId", "CollectiveId");
      CREATE INDEX community_activity_summary__collective_id ON "CommunityActivitySummary" ("CollectiveId");
      CREATE INDEX community_activity_summary__host_collective_id ON "CommunityActivitySummary" ("HostCollectiveId");
      CREATE INDEX community_activity_summary__from_collective_id ON "CommunityActivitySummary" ("FromCollectiveId");
    `);

    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW "CommunityTransactionSummary" as (
        WITH
          anual AS (
            SELECT
              COALESCE((c.data#>'{UserCollectiveId}')::INTEGER, c.id) as "FromCollectiveId", t."CollectiveId", t."HostCollectiveId", EXTRACT(YEAR FROM t."createdAt") AS year, t.kind, h.currency AS "hostCurrency",
              COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (WHERE t.type::text = 'DEBIT'::text), 0::bigint) AS "debitTotal",
              COALESCE(COUNT(t.id) FILTER (WHERE t.type::text = 'DEBIT'::text), 0::bigint) AS "debitCount",
              COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (WHERE t.type::text = 'CREDIT'::text), 0::bigint) AS "creditTotal",
              COALESCE(COUNT(t.id) FILTER (WHERE t.type::text = 'CREDIT'::text), 0::bigint) AS "creditCount",
              COALESCE(SUM(ABS(t."amountInHostCurrency")) FILTER (WHERE t.type::text = 'CREDIT'::text AND t."isRefund"), 0::bigint) AS "refundDebitTotal",
              COALESCE(COUNT(t.id) FILTER (WHERE t.type::text = 'CREDIT'::text AND t."isRefund"), 0::bigint) AS "refundDebitCount"
            FROM
              "Transactions" t
              JOIN "Collectives" h ON t."HostCollectiveId" = h.id
              JOIN "Collectives" c ON t."FromCollectiveId" = c.id
            WHERE t."deletedAt" IS NULL
              AND t."hostCurrency"::text = h.currency::text
            GROUP BY COALESCE((c.data#>'{UserCollectiveId}')::INTEGER, c.id), t."CollectiveId", t."HostCollectiveId", (EXTRACT(YEAR FROM t."createdAt")), h.currency, t.kind
            ORDER BY COALESCE((c.data#>'{UserCollectiveId}')::INTEGER, c.id), t."CollectiveId", t."HostCollectiveId", t.kind, (EXTRACT(YEAR FROM t."createdAt")) DESC
            )
        SELECT
          "FromCollectiveId", "CollectiveId", "HostCollectiveId", year, kind, "hostCurrency", "debitTotal", "debitCount", "creditTotal", "creditCount", "refundDebitTotal",
          "refundDebitCount", SUM("debitTotal") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "debitTotalAcc",
          SUM("debitCount") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "debitCountAcc",
          SUM("creditTotal") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "creditTotalAcc",
          SUM("creditCount") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "creditCountAcc",
          SUM("refundDebitTotal") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "refundDebitTotalAcc",
          SUM("refundDebitCount") OVER (PARTITION BY "FromCollectiveId", "HostCollectiveId", "CollectiveId", kind, "hostCurrency" ORDER BY year) AS "refundDebitCountAcc"
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
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CommunityHostTransactionsAggregated";`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityHostTransactionSummary";`);
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CommunityHostTransactionSummary";`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityHostYearlyTransactionSummary";`);
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CommunityHostYearlyTransactionSummary";`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityTransactionSummary";`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityActivitySummary";`);

    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW "CommunityActivitySummary" AS
      WITH
        relevant_activities AS (
          (
            SELECT
              a."HostCollectiveId", NULL::integer AS "UserId", a."FromCollectiveId", a."CollectiveId", a.type, a."createdAt",
              CASE
                WHEN a.type::text = ANY (ARRAY ['order.processed'::character varying, 'ticket.confirmed'::character varying]::text[]) THEN 'CONTRIBUTOR'::text
                WHEN a.type::text = 'collective.expense.paid'::text AND e.type = 'GRANT'::"enum_Expenses_type" THEN 'GRANTEE'::text
                WHEN a.type::text = 'collective.expense.paid'::text THEN 'PAYEE'::text
                WHEN a.type::text = 'collective.expense.created'::text THEN 'EXPENSE_SUBMITTER'::text
                ELSE NULL::text END AS relations
            FROM
              "Activities" a
              LEFT JOIN "Expenses" e ON a.type::text = 'collective.expense.paid'::text AND e.id = a."ExpenseId"
            WHERE a.type::text = ANY
                  (ARRAY ['order.processed'::character varying, 'collective.expense.approved'::character varying, 'collective.expense.paid'::character varying, 'collective.expense.created'::character varying, 'ticket.confirmed'::character varying]::text[])
            UNION ALL
            SELECT
              a."HostCollectiveId", a."UserId", NULL::integer AS "FromCollectiveId", a."CollectiveId", a.type, a."createdAt",
              CASE
                WHEN a.type::text = ANY (ARRAY ['collective.expense.approved'::character varying, 'collective.expense.rejected'::character varying]::text[]) THEN 'EXPENSE_APPROVER'::text
                ELSE NULL::text END AS relations
            FROM "Activities" a
            WHERE a.type::text = ANY (ARRAY ['collective.expense.approved'::character varying, 'collective.expense.rejected'::character varying]::text[])
            )
          UNION
          SELECT
            c."HostCollectiveId", u_1.id AS "UserId", m."MemberCollectiveId" AS "FromCollectiveId", c.id AS "CollectiveId", NULL::character varying AS type, m."createdAt",
            CASE WHEN m.role::text = 'BACKER'::text THEN 'CONTRIBUTOR'::character varying ELSE m.role END AS relations
          FROM
            "Members" m
            JOIN "Collectives" c ON m."CollectiveId" = c.id
            LEFT JOIN "Users" u_1 ON u_1."CollectiveId" = m."MemberCollectiveId"
          WHERE (m.role::text = ANY (ARRAY ['ADMIN'::character varying, 'CONTRIBUTOR'::character varying, 'ATTENDEE'::character varying, 'BACKER'::character varying]::text[]))
            AND m."deletedAt" IS NULL
          )
      SELECT
        ra."HostCollectiveId", ra."CollectiveId", COALESCE(ra."FromCollectiveId", u."CollectiveId") AS "FromCollectiveId", jsonb_agg_strict(DISTINCT ra.type) AS activities,
        jsonb_agg_strict(DISTINCT ra.relations) AS relations, MAX(ra."createdAt") AS "lastInteractionAt", MIN(ra."createdAt") AS "firstInteractionAt"
      FROM
        relevant_activities ra
        LEFT JOIN "Users" u ON u.id = ra."UserId"
      WHERE (ra."UserId" IS NOT NULL OR ra."FromCollectiveId" IS NOT NULL)
        AND ra."HostCollectiveId" IS NOT NULL
        AND ra."CollectiveId" IS NOT NULL
      GROUP BY
        ra."HostCollectiveId", ra."CollectiveId", (COALESCE(ra."FromCollectiveId", u."CollectiveId"));
    `);
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX community_activity_summary__all_collective_ids ON "CommunityActivitySummary" ("HostCollectiveId", "FromCollectiveId", "CollectiveId");
      CREATE INDEX community_activity_summary__collective_id ON "CommunityActivitySummary" ("CollectiveId");
      CREATE INDEX community_activity_summary__host_collective_id ON "CommunityActivitySummary" ("HostCollectiveId");
      CREATE INDEX community_activity_summary__from_collective_id ON "CommunityActivitySummary" ("FromCollectiveId");
    `);

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
};
