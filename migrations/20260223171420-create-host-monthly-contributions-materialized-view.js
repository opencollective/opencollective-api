'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
    CREATE MATERIALIZED VIEW "HostMonthlyContributions" AS
    SELECT
      DATE_TRUNC('month', COALESCE(t."clearedAt", t."createdAt") AT TIME ZONE 'UTC') AS "date",
      t."HostCollectiveId",
      SUM(t."amountInHostCurrency") AS "amountInHostCurrency",
      COUNT(t."id") AS "count",
      t."hostCurrency",
      CASE
        WHEN t."CollectiveId" = t."HostCollectiveId" THEN TRUE
        WHEN EXISTS (
          SELECT 1 FROM "Collectives" c
          WHERE c."id" = t."CollectiveId"
          AND c."ParentCollectiveId" = t."HostCollectiveId"
          AND c."type" != 'VENDOR'
        ) THEN TRUE
        ELSE FALSE
      END AS "isHost",
      NOW() AS "refreshedAt"
    FROM "Transactions" t
    WHERE
      t."deletedAt" IS NULL
      AND t."HostCollectiveId" IS NOT NULL
      AND t."kind" IN ('CONTRIBUTION', 'ADDED_FUNDS')
      AND t."type" = 'CREDIT'
      AND NOT t."isRefund"
      AND t."RefundTransactionId" IS NULL
    GROUP BY
      DATE_TRUNC('month', COALESCE(t."clearedAt", t."createdAt") AT TIME ZONE 'UTC'),
      t."HostCollectiveId",
      t."hostCurrency",
      "isHost"
    ORDER BY "date", t."HostCollectiveId";
  `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "host_monthly_contributions__host_collective_id" ON "HostMonthlyContributions"("HostCollectiveId");
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "host_monthly_contributions__host_collective_id";
    `);
    await queryInterface.sequelize.query(`
      DROP MATERIALIZED VIEW IF EXISTS "HostMonthlyContributions";
    `);
  },
};
