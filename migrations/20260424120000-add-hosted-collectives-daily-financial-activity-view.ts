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
          (c."deactivatedAt" IS NOT NULL
            AND (t."createdAt" AT TIME ZONE 'UTC')::date >= (c."deactivatedAt" AT TIME ZONE 'UTC')::date) AS "isArchived",
          ((CASE WHEN c."ParentCollectiveId" IS NOT NULL THEN p."deactivatedAt" ELSE c."deactivatedAt" END) IS NOT NULL
            AND (t."createdAt" AT TIME ZONE 'UTC')::date >=
                ((CASE WHEN c."ParentCollectiveId" IS NOT NULL THEN p."deactivatedAt" ELSE c."deactivatedAt" END) AT TIME ZONE 'UTC')::date) AS "mainAccountIsArchived",
          h.currency AS "hostCurrency",
          COALESCE(SUM(t."amountInHostCurrency") FILTER (
            WHERE t.type = 'CREDIT'
              AND NOT t."isRefund" AND t."RefundTransactionId" IS NULL AND NOT t."isInternal"
          ), 0) AS "amountReceived",
          COALESCE(SUM((COALESCE(t."amountInHostCurrency", 0) + COALESCE(t."platformFeeInHostCurrency", 0) + COALESCE(t."hostFeeInHostCurrency", 0) + COALESCE(t."paymentProcessorFeeInHostCurrency", 0) + COALESCE(t."taxAmount" * t."hostCurrencyFxRate", 0))) FILTER (
            WHERE ((t.type = 'CREDIT' AND NOT (t.kind = 'PAYMENT_PROCESSOR_COVER' AND t."OrderId" IS NULL))
                OR (t.type = 'DEBIT' AND t.kind = ANY('{HOST_FEE,PAYMENT_PROCESSOR_FEE}'::"enum_Transactions_kind"[]) AND t."OrderId" IS NOT NULL))
              AND NOT t."isRefund" AND t."RefundTransactionId" IS NULL AND NOT t."isInternal"
          ), 0) AS "amountReceivedNet",
          COALESCE(-SUM(t."amountInHostCurrency") FILTER (
            WHERE t.type = 'DEBIT' AND t.kind <> ALL('{HOST_FEE,PAYMENT_PROCESSOR_FEE}'::"enum_Transactions_kind"[])
              AND NOT t."isRefund" AND t."RefundTransactionId" IS NULL AND NOT t."isInternal"
          ), 0) AS "amountSpent",
          COALESCE(-SUM((COALESCE(t."amountInHostCurrency", 0) + COALESCE(t."platformFeeInHostCurrency", 0) + COALESCE(t."hostFeeInHostCurrency", 0) + COALESCE(t."paymentProcessorFeeInHostCurrency", 0) + COALESCE(t."taxAmount" * t."hostCurrencyFxRate", 0))) FILTER (
            WHERE ((t.type = 'DEBIT' AND NOT (t.kind = ANY('{HOST_FEE,PAYMENT_PROCESSOR_FEE}'::"enum_Transactions_kind"[]) AND t."OrderId" IS NOT NULL))
                OR (t.type = 'CREDIT' AND t.kind = 'PAYMENT_PROCESSOR_COVER' AND t."OrderId" IS NULL))
              AND NOT t."isRefund" AND t."RefundTransactionId" IS NULL AND NOT t."isInternal"
          ), 0) AS "amountSpentNet",
          COUNT(*) AS "transactionCount"
        FROM "Transactions" t
          INNER JOIN "Collectives" h ON t."HostCollectiveId" = h.id AND h."deletedAt" IS NULL
          INNER JOIN "Collectives" c ON t."CollectiveId" = c.id AND c."deletedAt" IS NULL
          LEFT  JOIN "Collectives" p ON p.id = c."ParentCollectiveId" AND p."deletedAt" IS NULL
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
          c."deactivatedAt",
          p."deactivatedAt",
          h.currency
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "hosted_collectives_daily_financial_activity__unique_index"
        ON "HostedCollectivesDailyFinancialActivity" ("HostCollectiveId", "CollectiveId", "day");
      CREATE INDEX IF NOT EXISTS "hosted_collectives_daily_financial_activity__host_day"
        ON "HostedCollectivesDailyFinancialActivity" ("HostCollectiveId", "day")
        INCLUDE ("CollectiveId", "ParentCollectiveId", "collectiveType", "mainAccountType", "isArchived", "mainAccountIsArchived", "amountReceived", "amountReceivedNet", "amountSpent", "amountSpentNet");
      CREATE INDEX IF NOT EXISTS "hosted_collectives_daily_financial_activity__host_collective"
        ON "HostedCollectivesDailyFinancialActivity" ("HostCollectiveId", "CollectiveId")
        INCLUDE ("day", "collectiveType", "mainAccountType", "isArchived", "mainAccountIsArchived", "amountReceived", "amountReceivedNet", "amountSpent", "amountSpentNet");
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "HostedCollectivesDailyFinancialActivity";`);
  },
};
