'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CurrentCollectiveBalance"`);

    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CollectiveBalanceCheckpoint"`);

    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "TransactionBalances"`);

    // Same as before, except the new sort
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
          RANK() OVER (
            PARTITION BY "CollectiveId", "hostCurrency"
            ORDER BY
            ROUND(EXTRACT(epoch FROM "createdAt") / 10) ASC,
            "TransactionGroup" ASC,
            CASE
              WHEN "kind" IN ('CONTRIBUTION', 'EXPENSE', 'ADDED_FUNDS', 'BALANCE_TRANSFER', 'PREPAID_PAYMENT_METHOD') THEN 1
              WHEN "kind" IN ('PLATFORM_TIP') THEN 2
              WHEN "kind" IN ('PLATFORM_TIP_DEBT') THEN 3
              WHEN "kind" IN ('PAYMENT_PROCESSOR_FEE') THEN 4
              WHEN "kind" IN ('PAYMENT_PROCESSOR_COVER') THEN 5
              WHEN "kind" IN ('HOST_FEE') THEN 6
              WHEN "kind" IN ('HOST_FEE_SHARE') THEN 7
              WHEN "kind" IN ('HOST_FEE_SHARE_DEBT') THEN 8
                ELSE 9
              END
            ASC,
            CASE
              WHEN "type" = 'DEBIT' THEN 1
                ELSE 2
              END
            ASC
          ) as "rank",
          SUM(
            COALESCE("amountInHostCurrency", 0)
            + COALESCE("platformFeeInHostCurrency", 0)
            + COALESCE("hostFeeInHostCurrency", 0)
            + COALESCE("paymentProcessorFeeInHostCurrency", 0)
            + COALESCE("taxAmount" * "hostCurrencyFxRate", 0)
          ) OVER (
            PARTITION BY "CollectiveId", "hostCurrency"
            ORDER BY
            ROUND(EXTRACT(epoch FROM "createdAt") / 10) ASC,
            "TransactionGroup" ASC,
            CASE
              WHEN "kind" IN ('CONTRIBUTION', 'EXPENSE', 'ADDED_FUNDS', 'BALANCE_TRANSFER', 'PREPAID_PAYMENT_METHOD') THEN 1
              WHEN "kind" IN ('PLATFORM_TIP') THEN 2
              WHEN "kind" IN ('PLATFORM_TIP_DEBT') THEN 3
              WHEN "kind" IN ('PAYMENT_PROCESSOR_FEE') THEN 4
              WHEN "kind" IN ('PAYMENT_PROCESSOR_COVER') THEN 5
              WHEN "kind" IN ('HOST_FEE') THEN 6
              WHEN "kind" IN ('HOST_FEE_SHARE') THEN 7
              WHEN "kind" IN ('HOST_FEE_SHARE_DEBT') THEN 8
                ELSE 9
              END
            ASC,
            CASE
              WHEN "type" = 'DEBIT' THEN 1
                ELSE 2
              END
            ASC
          ) as "balance"
          FROM "Transactions", "ActiveCollectives"
          WHERE "CollectiveId" = "ActiveCollectives"."ActiveCollectiveId"
          AND "deletedAt" IS NULL
       )
    `);

    // Add a unique index on transaction ID to the materialized view
    await queryInterface.sequelize.query(`CREATE UNIQUE INDEX CONCURRENTLY ON "TransactionBalances"(id)`);

    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS "CollectiveBalanceCheckpoint" AS (
        WITH "LatestTransactionBalances" AS (
          SELECT "CollectiveId", MAX("rank") AS "rank", MAX("createdAt") as "lastCreatedAt"
          FROM "TransactionBalances"
          GROUP BY "CollectiveId"
        )
        SELECT tb."id", tb."CollectiveId", tb."balance", tb."hostCurrency",
        ltb."lastCreatedAt" as "createdAt"
        FROM "TransactionBalances" tb
        INNER JOIN "LatestTransactionBalances" ltb
        ON tb."rank" = ltb."rank" AND tb."CollectiveId" = ltb."CollectiveId"
       )
    `);

    // Copied from migrations/20230213080003-fast-balance-update.js
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "collective_balance_checkpoint__collective_id"
      ON "CollectiveBalanceCheckpoint"("CollectiveId")
    `);

    await recreateUnmodifiedViews(queryInterface);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CurrentCollectiveBalance"`);

    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CollectiveBalanceCheckpoint"`);

    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "TransactionBalances"`);

    // Copied from migrations/20230104225718-transaction-balances-order-by-create-date.js
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

    // Add a unique index on transaction ID to the materialized view
    await queryInterface.sequelize.query(`CREATE UNIQUE INDEX CONCURRENTLY ON "TransactionBalances"(id)`);

    // Copied from migrations/20230213080003-fast-balance-update.js
    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS "CollectiveBalanceCheckpoint" AS (
        WITH "LatestTransactions" AS (
          SELECT "CollectiveId", MAX("createdAt") AS "createdAt" FROM "TransactionBalances" GROUP BY "CollectiveId"
        )
        SELECT *
        FROM "TransactionBalances"
        WHERE id IN (
          SELECT MAX(tb."id") FROM "TransactionBalances" tb
          INNER JOIN "LatestTransactions" lt ON lt."CollectiveId" = tb."CollectiveId" AND lt."createdAt" = tb."createdAt"
          GROUP BY tb."CollectiveId"
        )
       )
    `);

    // Copied from migrations/20230213080003-fast-balance-update.js
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "collective_balance_checkpoint__collective_id"
      ON "CollectiveBalanceCheckpoint"("CollectiveId")
    `);

    await recreateUnmodifiedViews(queryInterface);
  },
};

async function recreateUnmodifiedViews(queryInterface) {
  // Copied from migrations/20230213080003-fast-balance-update.js
  await queryInterface.sequelize.query(`
    CREATE OR REPLACE VIEW "CurrentCollectiveBalance" as (
      SELECT
        cbc."CollectiveId",
        cbc."balance" + coalesce(t."netAmountInHostCurrency", 0) "netAmountInHostCurrency",
        coalesce(disputed."netAmountInHostCurrency", 0) "disputedNetAmountInHostCurrency",
        cbc."hostCurrency"
      FROM "CollectiveBalanceCheckpoint" cbc
      LEFT JOIN LATERAL (
        SELECT
          SUM(t."amountInHostCurrency") +
            SUM(coalesce(t."platformFeeInHostCurrency", 0)) +
            SUM(coalesce(t."hostFeeInHostCurrency", 0)) +
            SUM(coalesce(t."paymentProcessorFeeInHostCurrency", 0)) +
            SUM(coalesce(t."taxAmount" * t."hostCurrencyFxRate", 0)) "netAmountInHostCurrency"
        FROM "Transactions" t
        WHERE t."CollectiveId" = cbc."CollectiveId"
          AND t."createdAt" > cbc."createdAt"
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
        where t."CollectiveId" = cbc."CollectiveId"
          AND t."deletedAt" is null
          AND t."isDisputed"
          AND t."RefundTransactionId" is null
        GROUP BY t."CollectiveId"
      ) as disputed ON TRUE
    );
  `);
}
