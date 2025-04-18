'use strict';

/**
 * /!\ When updating `CurrentCollectiveTransactionStats`, remember to also update `CurrentCollectiveTransactionStatsIndex`.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CurrentCollectiveTransactionStats"`);

    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CollectiveTransactionStats"`);

    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW "CollectiveTransactionStats" AS

        WITH "ActiveCollectives" AS (
          SELECT c."id" as "CollectiveId"
          FROM "Transactions" t
          LEFT JOIN "Collectives" c ON c."id" = t."CollectiveId" AND c."deletedAt" IS NULL
          WHERE t."deletedAt" IS NULL
            AND t."hostCurrency" IS NOT NULL
            AND c."deactivatedAt" IS NULL
            -- TODO: not sure why we have those conditions on guest/incognito, too many accounts?
            AND (c."data" ->> 'isGuest')::boolean IS NOT TRUE
            AND c.name != 'incognito'
            AND c.name != 'anonymous'
            AND c."isIncognito" = FALSE
          GROUP BY c."id"
          HAVING COUNT(DISTINCT t."hostCurrency") = 1 -- no hostCurrency mismatch please!
        )
        SELECT
          ac."CollectiveId" as "id",
          MAX(t."createdAt") as "LatestTransactionCreatedAt",
          COUNT(DISTINCT t.id) AS "count",

          SUM(t."amountInHostCurrency")
            FILTER (
              -- Get all credits
              WHERE (t.type = 'CREDIT'
                AND NOT (t.kind = 'PAYMENT_PROCESSOR_COVER')
              )
            )
            AS "totalAmountReceivedInHostCurrency",

          SUM(
            COALESCE(t."amountInHostCurrency", 0) +
            COALESCE(t."platformFeeInHostCurrency", 0) +
            COALESCE(t."hostFeeInHostCurrency", 0) +
            COALESCE(t."paymentProcessorFeeInHostCurrency", 0) +
            COALESCE(t."taxAmount" * t."hostCurrencyFxRate", 0)
          )
            FILTER (
              -- Get all credits except PAYMENT_PROCESSOR_COVER from expenses or from before split fees
              WHERE (t.type = 'CREDIT' AND NOT (
                t.kind = 'PAYMENT_PROCESSOR_COVER' AND (t."OrderId" IS NULL OR t."createdAt" < '2024-01-01')
              ))
              -- Deduct host fees and payment processor fees that are related to orders
              OR (t.type = 'DEBIT' AND (
                t.kind IN ('HOST_FEE', 'PAYMENT_PROCESSOR_FEE') AND t."OrderId" IS NOT NULL
              ))
            )
            AS "totalNetAmountReceivedInHostCurrency",

          SUM(t."amountInHostCurrency")
            FILTER (
              WHERE t.type = 'DEBIT' AND NOT (
                -- Do not include for orders or expenses
                t.kind IN ('HOST_FEE', 'PAYMENT_PROCESSOR_FEE')
              )
            )
            AS "totalAmountSpentInHostCurrency",

          SUM(
            COALESCE(t."amountInHostCurrency", 0) +
            COALESCE(t."platformFeeInHostCurrency", 0) +
            COALESCE(t."hostFeeInHostCurrency", 0) +
            COALESCE(t."paymentProcessorFeeInHostCurrency", 0) +
            COALESCE(t."taxAmount" * t."hostCurrencyFxRate", 0)
          )
            FILTER (
              WHERE (t.type = 'DEBIT' AND NOT (
               -- Do not include fees for orders, include for expenses
                t.kind IN ('HOST_FEE', 'PAYMENT_PROCESSOR_FEE') AND t."OrderId" IS NOT NULL
              )) OR (
                t.type = 'CREDIT' AND t.kind = 'PAYMENT_PROCESSOR_COVER' AND t."OrderId" IS NULL
              )
            )
            AS "totalNetAmountSpentInHostCurrency",

          MAX(t."hostCurrency") as "hostCurrency"

        FROM "ActiveCollectives" ac

        INNER JOIN "Transactions" t ON t."CollectiveId" = ac."CollectiveId"
          AND t."deletedAt" IS NULL
          AND t."RefundTransactionId" IS NULL
          AND (t."isRefund" IS NOT TRUE OR t."kind" = 'PAYMENT_PROCESSOR_COVER')
          AND t."isInternal" IS NOT TRUE

        GROUP BY ac."CollectiveId";
    `);

    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "collective_transaction_stats__id" ON "CollectiveTransactionStats" (id);`,
    );

    await queryInterface.sequelize.query(`
      CREATE OR REPLACE VIEW "CurrentCollectiveTransactionStats" as (
        SELECT
          cts."id" as "CollectiveId",

          COALESCE(cts."totalAmountReceivedInHostCurrency", 0) + COALESCE(t."totalAmountReceivedInHostCurrency", 0)
            AS "totalAmountReceivedInHostCurrency",
          COALESCE(cts."totalNetAmountReceivedInHostCurrency", 0) + COALESCE(t."totalNetAmountReceivedInHostCurrency", 0)
            AS "totalNetAmountReceivedInHostCurrency",
          COALESCE(cts."totalAmountSpentInHostCurrency", 0) + COALESCE(t."totalAmountSpentInHostCurrency", 0)
            AS "totalAmountSpentInHostCurrency",
          COALESCE(cts."totalNetAmountSpentInHostCurrency", 0) + COALESCE(t."totalNetAmountSpentInHostCurrency", 0)
            AS "totalNetAmountSpentInHostCurrency",

          cts."hostCurrency"

        FROM "CollectiveTransactionStats" cts

        LEFT JOIN LATERAL (
          SELECT

          SUM(t."amountInHostCurrency")
            FILTER (
              -- Get all credits
              WHERE (t.type = 'CREDIT'
                AND NOT (t.kind = 'PAYMENT_PROCESSOR_COVER')
              )
            )
            AS "totalAmountReceivedInHostCurrency",

          SUM(
            COALESCE(t."amountInHostCurrency", 0) +
            COALESCE(t."platformFeeInHostCurrency", 0) +
            COALESCE(t."hostFeeInHostCurrency", 0) +
            COALESCE(t."paymentProcessorFeeInHostCurrency", 0) +
            COALESCE(t."taxAmount" * t."hostCurrencyFxRate", 0)
          )
            FILTER (
              -- Get all credits except PAYMENT_PROCESSOR_COVER from expenses or from before split fees
              WHERE (t.type = 'CREDIT' AND NOT (
                t.kind = 'PAYMENT_PROCESSOR_COVER' AND (t."OrderId" IS NULL OR t."createdAt" < '2024-01-01')
              ))
              -- Deduct host fees and payment processor fees that are related to orders
              OR (t.type = 'DEBIT' AND (
                t.kind IN ('HOST_FEE', 'PAYMENT_PROCESSOR_FEE') AND t."OrderId" IS NOT NULL
              ))
            )
            AS "totalNetAmountReceivedInHostCurrency",

          SUM(t."amountInHostCurrency")
            FILTER (
              WHERE t.type = 'DEBIT' AND NOT (
                -- Do not include for orders or expenses
                t.kind IN ('HOST_FEE', 'PAYMENT_PROCESSOR_FEE')
              )
            )
            AS "totalAmountSpentInHostCurrency",

          SUM(
            COALESCE(t."amountInHostCurrency", 0) +
            COALESCE(t."platformFeeInHostCurrency", 0) +
            COALESCE(t."hostFeeInHostCurrency", 0) +
            COALESCE(t."paymentProcessorFeeInHostCurrency", 0) +
            COALESCE(t."taxAmount" * t."hostCurrencyFxRate", 0)
          )
            FILTER (
              WHERE (t.type = 'DEBIT' AND NOT (
                -- Do not include fees for orders, include for expenses
                t.kind IN ('HOST_FEE', 'PAYMENT_PROCESSOR_FEE') AND t."OrderId" IS NOT NULL
              )) OR (
                t.type = 'CREDIT' AND t.kind = 'PAYMENT_PROCESSOR_COVER' AND t."OrderId" IS NULL
              )
            )
            AS "totalNetAmountSpentInHostCurrency"

          FROM "Transactions" t
          WHERE t."CollectiveId" = cts."id"
            AND ROUND(EXTRACT(epoch FROM t."createdAt" AT TIME ZONE 'UTC') / 10) > ROUND(EXTRACT(epoch FROM cts."LatestTransactionCreatedAt" AT TIME ZONE 'UTC') / 10)
            AND t."deletedAt" is null
            AND t."RefundTransactionId" IS NULL
            AND (t."isRefund" IS NOT TRUE OR t."kind" = 'PAYMENT_PROCESSOR_COVER')
            AND t."isInternal" IS NOT TRUE

          GROUP by t."CollectiveId"
        ) as t ON TRUE
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS "CurrentCollectiveTransactionStats"`);

    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CollectiveTransactionStats"`);

    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW "CollectiveTransactionStats" AS

        WITH "ActiveCollectives" AS (
          SELECT c."id" as "CollectiveId"
          FROM "Transactions" t
          LEFT JOIN "Collectives" c ON c."id" = t."CollectiveId" AND c."deletedAt" IS NULL
          WHERE t."deletedAt" IS NULL
            AND t."hostCurrency" IS NOT NULL
            AND c."deactivatedAt" IS NULL
            -- TODO: not sure why we have those conditions on guest/incognito, too many accounts?
            AND (c."data" ->> 'isGuest')::boolean IS NOT TRUE
            AND c.name != 'incognito'
            AND c.name != 'anonymous'
            AND c."isIncognito" = FALSE
          GROUP BY c."id"
          HAVING COUNT(DISTINCT t."hostCurrency") = 1 -- no hostCurrency mismatch please!
        )
        SELECT
          ac."CollectiveId" as "id",
          MAX(t."createdAt") as "LatestTransactionCreatedAt",
          COUNT(DISTINCT t.id) AS "count",

          SUM(t."amountInHostCurrency")
            FILTER (WHERE t.type = 'CREDIT' AND t."kind" NOT IN ('PAYMENT_PROCESSOR_COVER'))
            AS "totalAmountReceivedInHostCurrency",

          SUM(
            COALESCE(t."amountInHostCurrency", 0) +
            COALESCE(t."platformFeeInHostCurrency", 0) +
            COALESCE(t."hostFeeInHostCurrency", 0) +
            COALESCE(t."paymentProcessorFeeInHostCurrency", 0) +
            COALESCE(t."taxAmount" * t."hostCurrencyFxRate", 0)
          )
            FILTER (
              -- Get all credits except PAYMENT_PROCESSOR_COVER from expenses
              WHERE (t.type = 'CREDIT' AND NOT (t.kind = 'PAYMENT_PROCESSOR_COVER' AND t."OrderId" IS NULL))
              -- Deduct host fees and payment processor fees that are related to orders
              OR (t.type = 'DEBIT' AND t.kind IN ('HOST_FEE', 'PAYMENT_PROCESSOR_FEE') AND t."OrderId" IS NOT NULL)
            )
            AS "totalNetAmountReceivedInHostCurrency",

          SUM(t."amountInHostCurrency")
            FILTER (WHERE t.type = 'DEBIT' AND t.kind != 'HOST_FEE' AND t.kind != 'PAYMENT_PROCESSOR_FEE')
            AS "totalAmountSpentInHostCurrency",

          SUM(
            COALESCE(t."amountInHostCurrency", 0) +
            COALESCE(t."platformFeeInHostCurrency", 0) +
            COALESCE(t."hostFeeInHostCurrency", 0) +
            COALESCE(t."paymentProcessorFeeInHostCurrency", 0) +
            COALESCE(t."taxAmount" * t."hostCurrencyFxRate", 0)
          )
            FILTER (WHERE (t.type = 'DEBIT' AND t.kind != 'HOST_FEE') OR (t.type = 'CREDIT' AND t.kind = 'PAYMENT_PROCESSOR_COVER'))
            AS "totalNetAmountSpentInHostCurrency",

          MAX(t."hostCurrency") as "hostCurrency"

        FROM "ActiveCollectives" ac

        INNER JOIN "Transactions" t ON t."CollectiveId" = ac."CollectiveId"
          AND t."deletedAt" IS NULL
          AND t."RefundTransactionId" IS NULL
          AND (t."isRefund" IS NOT TRUE OR t."kind" = 'PAYMENT_PROCESSOR_COVER')
          AND t."isInternal" IS NOT TRUE

        GROUP BY ac."CollectiveId";
    `);

    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "collective_transaction_stats__id" ON "CollectiveTransactionStats" (id);`,
    );

    await queryInterface.sequelize.query(`
      CREATE OR REPLACE VIEW "CurrentCollectiveTransactionStats" as (
        SELECT
          cts."id" as "CollectiveId",

          COALESCE(cts."totalAmountReceivedInHostCurrency", 0) + COALESCE(t."totalAmountReceivedInHostCurrency", 0)
            AS "totalAmountReceivedInHostCurrency",
          COALESCE(cts."totalNetAmountReceivedInHostCurrency", 0) + COALESCE(t."totalNetAmountReceivedInHostCurrency", 0)
            AS "totalNetAmountReceivedInHostCurrency",
          COALESCE(cts."totalAmountSpentInHostCurrency", 0) + COALESCE(t."totalAmountSpentInHostCurrency", 0)
            AS "totalAmountSpentInHostCurrency",
          COALESCE(cts."totalNetAmountSpentInHostCurrency", 0) + COALESCE(t."totalNetAmountSpentInHostCurrency", 0)
            AS "totalNetAmountSpentInHostCurrency",

          cts."hostCurrency"

        FROM "CollectiveTransactionStats" cts

        LEFT JOIN LATERAL (
          SELECT

          SUM(t."amountInHostCurrency")
            FILTER (WHERE t.type = 'CREDIT' AND t."kind" NOT IN ('PAYMENT_PROCESSOR_COVER'))
            AS "totalAmountReceivedInHostCurrency",

          SUM(
            COALESCE(t."amountInHostCurrency", 0) +
            COALESCE(t."platformFeeInHostCurrency", 0) +
            COALESCE(t."hostFeeInHostCurrency", 0) +
            COALESCE(t."paymentProcessorFeeInHostCurrency", 0) +
            COALESCE(t."taxAmount" * t."hostCurrencyFxRate", 0)
          )
            FILTER (
              -- Get all credits except PAYMENT_PROCESSOR_COVER from expenses
              WHERE (t.type = 'CREDIT' AND NOT (t.kind = 'PAYMENT_PROCESSOR_COVER' AND t."OrderId" IS NULL))
              -- Deduct host fees and payment processor fees that are related to orders
              OR (t.type = 'DEBIT' AND t.kind IN ('HOST_FEE', 'PAYMENT_PROCESSOR_FEE') AND t."OrderId" IS NOT NULL)
            )
            AS "totalNetAmountReceivedInHostCurrency",

          SUM(t."amountInHostCurrency")
            FILTER (WHERE t.type = 'DEBIT' AND t.kind != 'HOST_FEE' AND t.kind != 'PAYMENT_PROCESSOR_FEE')
            AS "totalAmountSpentInHostCurrency",

          SUM(
            COALESCE(t."amountInHostCurrency", 0) +
            COALESCE(t."platformFeeInHostCurrency", 0) +
            COALESCE(t."hostFeeInHostCurrency", 0) +
            COALESCE(t."paymentProcessorFeeInHostCurrency", 0) +
            COALESCE(t."taxAmount" * t."hostCurrencyFxRate", 0)
          )
            FILTER (WHERE (t.type = 'DEBIT' AND t.kind != 'HOST_FEE') OR (t.type = 'CREDIT' AND t.kind = 'PAYMENT_PROCESSOR_COVER'))
            AS "totalNetAmountSpentInHostCurrency"

          FROM "Transactions" t
          WHERE t."CollectiveId" = cts."id"
            AND ROUND(EXTRACT(epoch FROM t."createdAt" AT TIME ZONE 'UTC') / 10) > ROUND(EXTRACT(epoch FROM cts."LatestTransactionCreatedAt" AT TIME ZONE 'UTC') / 10)
            AND t."deletedAt" is null
            AND t."RefundTransactionId" IS NULL
            AND (t."isRefund" IS NOT TRUE OR t."kind" = 'PAYMENT_PROCESSOR_COVER')
            AND t."isInternal" IS NOT TRUE

          GROUP by t."CollectiveId"
        ) as t ON TRUE
      );
    `);
  },
};
