'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW "CollectiveTransactionStats" AS
        SELECT
          c.id,
          COUNT(DISTINCT t.id) AS "count",
          SUM(t."amountInHostCurrency") FILTER (WHERE t.type = 'CREDIT') AS "totalAmountReceivedInHostCurrency",
          SUM(ABS(t."amountInHostCurrency")) FILTER (WHERE t.type = 'DEBIT') AS "totalAmountSpentInHostCurrency"
        FROM "Collectives" c
        LEFT JOIN "Transactions" t ON t."CollectiveId" = c.id AND t."deletedAt" IS NULL AND t."RefundTransactionId" IS NULL
        WHERE c."deletedAt" IS NULL
        AND c."deactivatedAt" IS NULL
        AND (c."data" ->> 'isGuest')::boolean IS NOT TRUE
        AND c.name != 'incognito'
        AND c.name != 'anonymous'
        AND c."isIncognito" = FALSE
        GROUP BY c.id
    `);

    // Add a unique index on collective ID to the materialized view
    await queryInterface.sequelize.query(`CREATE UNIQUE INDEX CONCURRENTLY ON "CollectiveTransactionStats"(id)`);
  },

  async down(queryInterface) {
    // Remember to remove `cron/hourly/50-refresh-collective-stats-materialized-view.js` if you get rid of this view
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW "CollectiveTransactionStats"`);
  },
};
