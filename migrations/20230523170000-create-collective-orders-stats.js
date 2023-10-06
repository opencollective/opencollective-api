'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS "CollectiveOrderStats" AS
      WITH ma AS (
        SELECT
          o."CollectiveId",
          DATE_TRUNC('month', o."createdAt") AS "month",
          ROUND(COALESCE(AVG(CASE WHEN o."status" = 'ERROR' THEN 1 ELSE 0 END), 0), 5)::FLOAT AS "errorRate",
          ROUND(COALESCE(AVG(CASE WHEN o."status" IN ('PAID', 'ACTIVE') THEN 1 ELSE 0 END), 0), 5)::FLOAT AS "successRate",
          COUNT(*) AS "numberOfOrders"
        FROM
            "Orders" o
        LEFT JOIN "Collectives" c ON c."id" = o."CollectiveId"
        WHERE
          o."deletedAt" IS NULL
          AND o."createdAt" > NOW() - INTERVAL '1 year'
          AND c."deletedAt" IS NULL
          AND c."isActive" IS TRUE
        GROUP BY
          o."CollectiveId",
          "month"
        ORDER BY "month" ASC
      ), acc AS (
        SELECT
          "CollectiveId",
          "month",
          RANK() OVER w AS "months",
          "errorRate",
          AVG("errorRate") OVER w AS "accErrorRate",
          "successRate",
          AVG("successRate") OVER w AS "accSuccessRate",
          SUM("numberOfOrders") OVER w AS "accNumberOfOrders"
        FROM ma
        WINDOW w AS (PARTITION BY "CollectiveId" ORDER BY "month" DESC)
      )
      SELECT
        "CollectiveId",
        MAX("accErrorRate") FILTER (WHERE "months" = 1) AS "errorRate1M",
        MAX("accErrorRate") FILTER (WHERE "months" = 3) AS "errorRate3M",
        MAX("accErrorRate") FILTER (WHERE "months" = 12) AS "errorRate12M",
        MAX("accSuccessRate") FILTER (WHERE "months" = 3) AS "successRate1M",
        MAX("accSuccessRate") FILTER (WHERE "months" = 3) AS "successRate3M",
        MAX("accSuccessRate") FILTER (WHERE "months" = 12) AS "successRate12M",
        MAX("accNumberOfOrders") FILTER (WHERE "months" = 1) AS "numOrders1M",
        MAX("accNumberOfOrders") FILTER (WHERE "months" = 3) AS "numOrders3M",
        MAX("accNumberOfOrders") FILTER (WHERE "months" = 12) AS "numOrders12M"
      FROM acc
      GROUP BY "CollectiveId" 
      `);

    await queryInterface.sequelize.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS collective_order_stats__CollectiveId ON "CollectiveOrderStats"("CollectiveId")`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS collective_order_stats__CollectiveId`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW "CollectiveOrderStats"`);
  },
};
