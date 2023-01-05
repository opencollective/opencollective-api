'use strict';

/* Remove dependent objects of TransactionBalances materialized view */
const removeDependentObjectsTransactionBalances = async queryInterface => {
  await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transaction_balances__collective_id"
    `);

  await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CurrentCollectiveBalance"`);

  await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CollectiveBalanceCheckpoint"`);
};

async function recreateDependentObjectsTransactionBalances(queryInterface) {
  await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transaction_balances__collective_id"
      ON "TransactionBalances"("CollectiveId")
    `);

  await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS "CollectiveBalanceCheckpoint" AS (
        WITH "LatestTransactionIds" AS (
          SELECT MAX("id") as "id"
          FROM "TransactionBalances"
          GROUP BY "CollectiveId"
        )
        SELECT tb.*
        FROM "TransactionBalances" tb
        INNER JOIN "LatestTransactionIds" lb ON tb."id" = lb."id"
       )
    `);

  await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "collective_balance_checkpoint__collective_id"
      ON "CollectiveBalanceCheckpoint"("CollectiveId")
    `);

  await queryInterface.sequelize.query(`
      CREATE OR REPLACE VIEW "CurrentCollectiveBalance" as (
        SELECT
          tb."CollectiveId",
          tb."balance" + coalesce(t."netAmountInHostCurrency", 0) "netAmountInHostCurrency",
          coalesce(disputed."netAmountInHostCurrency", 0) "disputedNetAmountInHostCurrency",
          tb."hostCurrency"
        FROM "TransactionBalances" tb
        INNER JOIN "CollectiveBalanceCheckpoint" cbc ON tb."id" = cbc."id"
        LEFT JOIN LATERAL (
          SELECT
            SUM(t."amountInHostCurrency") +
              SUM(coalesce(t."platformFeeInHostCurrency", 0)) +
              SUM(coalesce(t."hostFeeInHostCurrency", 0)) +
              SUM(coalesce(t."paymentProcessorFeeInHostCurrency", 0)) +
              SUM(coalesce(t."taxAmount" * t."hostCurrencyFxRate", 0)) "netAmountInHostCurrency"
          FROM "Transactions" t
          WHERE t."CollectiveId" = tb."CollectiveId"
            AND t.id > tb."id"
            AND t."deletedAt" is null
          GROUP by t."CollectiveId"
        ) as t ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            SUM(t."amountInHostCurrency") +
              SUM(coalesce(t."platformFeeInHostCurrency", 0)) +
              SUM(coalesce(t."hostFeeInHostCurrency", 0)) +
              SUM(coalesce(t."paymentProcessorFeeInHostCurrency", 0)) +
              SUM(coalesce(t."taxAmount" * t."hostCurrencyFxRate", 0)) "netAmountInHostCurrency"
          FROM "Transactions" t
          where t."CollectiveId" = tb."CollectiveId"
            AND t."deletedAt" is null
            AND t."isDisputed"
            AND t."RefundTransactionId" is null
          GROUP BY t."CollectiveId"
        ) as disputed ON TRUE
      );
    `);
}

module.exports = {
  async up(queryInterface) {
    // Remove dependent objects of TransactionBalances materialized view
    await removeDependentObjectsTransactionBalances(queryInterface);

    /* START: Update TransactionBalances materialized view */
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW "TransactionBalances"`);

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
          ) OVER (PARTITION BY "CollectiveId", "hostCurrency" ORDER BY "createdAt" ASC, "id" ASC) as "balance"
          FROM "Transactions", "ActiveCollectives"
          WHERE "deletedAt" IS NULL
          AND "CollectiveId" = "ActiveCollectives"."ActiveCollectiveId"
          ORDER BY "createdAt" ASC
       )
    `);

    // Add a unique index on collective ID to the materialized view
    await queryInterface.sequelize.query(`CREATE UNIQUE INDEX CONCURRENTLY ON "TransactionBalances"(id)`);
    /* END: Update TransactionBalances materialized view */

    // Recreate dependent objects of TransactionBalances materialized view
    await recreateDependentObjectsTransactionBalances(queryInterface);
  },

  async down(queryInterface) {
    // Remove dependent objects of TransactionBalances materialized view
    await removeDependentObjectsTransactionBalances(queryInterface);

    /* START: Update TransactionBalances materialized view */
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW "TransactionBalances"`);

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
    /* END: Update TransactionBalances materialized view */

    // Recreate dependent objects of TransactionBalances materialized view
    await recreateDependentObjectsTransactionBalances(queryInterface);
  },
};
