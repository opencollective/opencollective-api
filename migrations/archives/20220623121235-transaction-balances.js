'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW "TransactionBalances" AS (
        WITH "ActiveCollectives" AS (
          SELECT t."CollectiveId" as "ActiveCollectiveId"
          FROM "Transactions" t
          LEFT JOIN  "Collectives" c ON c."id" = t."CollectiveId" AND c."deletedAt" IS NULL
          WHERE t."deletedAt" IS NULL AND t."hostCurrency" IS NOT NULL
          AND c."isActive" IS TRUE
          GROUP BY t."CollectiveId"
          HAVING COUNT(DISTINCT t."hostCurrency") = 1
        )
        SELECT
          "id",
          "CollectiveId",
          "createdAt",
          "hostCurrency",
          SUM(
            COALESCE("amountInHostCurrency", 0)
            + COALESCE("platformFeeInHostCurrency", 0)
            + COALESCE("hostFeeInHostCurrency", 0)
            + COALESCE("paymentProcessorFeeInHostCurrency", 0)
            + COALESCE("taxAmount" * "hostCurrencyFxRate", 0)
          ) OVER (PARTITION BY "CollectiveId", "hostCurrency" ORDER BY "id") as "balance"
          FROM "Transactions", "ActiveCollectives"
          WHERE "deletedAt" IS NULL
          AND "CollectiveId" = "ActiveCollectives"."ActiveCollectiveId"
          ORDER BY "createdAt" ASC
       )
    `);

    // Add a unique index on collective ID to the materialized view
    await queryInterface.sequelize.query(`CREATE UNIQUE INDEX CONCURRENTLY ON "TransactionBalances"(id)`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW "TransactionBalances"`);
  },
};
