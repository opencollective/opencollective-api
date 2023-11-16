'use strict';

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
            -- TODO: not sure why we have those conditions omn guest/incognito, too many accounts?
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
            FILTER (WHERE t.type = 'CREDIT' OR (t.type = 'DEBIT' AND t.kind IN ('HOST_FEE', 'PAYMENT_PROCESSOR_FEE')))
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
            FILTER (WHERE t.type = 'CREDIT' OR (t.type = 'DEBIT' AND t.kind IN ('HOST_FEE', 'PAYMENT_PROCESSOR_FEE')))
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
            AND t."createdAt" > cts."LatestTransactionCreatedAt"
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
            -- TODO: not sure why we have those conditions omn guest/incognito, too many accounts?
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
            FILTER (WHERE t.type = 'CREDIT')
            AS "totalAmountReceivedInHostCurrency",

          SUM(
            COALESCE(t."amountInHostCurrency", 0) +
            COALESCE(t."platformFeeInHostCurrency", 0) +
            COALESCE(t."hostFeeInHostCurrency", 0) +
            COALESCE(t."paymentProcessorFeeInHostCurrency", 0) +
            COALESCE(t."taxAmount" * t."hostCurrencyFxRate", 0)
          )
            FILTER (WHERE t.type = 'CREDIT' OR (t.type = 'DEBIT' AND t.kind = 'HOST_FEE'))
            AS "totalNetAmountReceivedInHostCurrency",

          SUM(t."amountInHostCurrency")
            FILTER (WHERE t.type = 'DEBIT' AND t.kind != 'HOST_FEE')
            AS "totalAmountSpentInHostCurrency",

          SUM(
            COALESCE(t."amountInHostCurrency", 0) +
            COALESCE(t."platformFeeInHostCurrency", 0) +
            COALESCE(t."hostFeeInHostCurrency", 0) +
            COALESCE(t."paymentProcessorFeeInHostCurrency", 0) +
            COALESCE(t."taxAmount" * t."hostCurrencyFxRate", 0)
          )
            FILTER (WHERE t.type = 'DEBIT' AND t.kind != 'HOST_FEE')
            AS "totalNetAmountSpentInHostCurrency",

          MAX(t."hostCurrency") as "hostCurrency"

        FROM "ActiveCollectives" ac

        INNER JOIN "Transactions" t ON t."CollectiveId" = ac."CollectiveId"
          AND t."deletedAt" IS NULL
          AND t."RefundTransactionId" IS NULL
          AND t."isRefund" IS NOT TRUE
          AND t."isInternal" IS NOT TRUE

        GROUP BY ac."CollectiveId";
    `);

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
            FILTER (WHERE t.type = 'CREDIT')
            AS "totalAmountReceivedInHostCurrency",

          SUM(
            COALESCE(t."amountInHostCurrency", 0) +
            COALESCE(t."platformFeeInHostCurrency", 0) +
            COALESCE(t."hostFeeInHostCurrency", 0) +
            COALESCE(t."paymentProcessorFeeInHostCurrency", 0) +
            COALESCE(t."taxAmount" * t."hostCurrencyFxRate", 0)
          )
            FILTER (WHERE t.type = 'CREDIT' OR (t.type = 'DEBIT' AND t.kind = 'HOST_FEE'))
            AS "totalNetAmountReceivedInHostCurrency",

          SUM(t."amountInHostCurrency")
            FILTER (WHERE t.type = 'DEBIT' AND t.kind != 'HOST_FEE')
            AS "totalAmountSpentInHostCurrency",

          SUM(
            COALESCE(t."amountInHostCurrency", 0) +
            COALESCE(t."platformFeeInHostCurrency", 0) +
            COALESCE(t."hostFeeInHostCurrency", 0) +
            COALESCE(t."paymentProcessorFeeInHostCurrency", 0) +
            COALESCE(t."taxAmount" * t."hostCurrencyFxRate", 0)
          )
            FILTER (WHERE t.type = 'DEBIT' AND t.kind != 'HOST_FEE')
            AS "totalNetAmountSpentInHostCurrency"

          FROM "Transactions" t
          WHERE t."CollectiveId" = cts."id"
            AND t."createdAt" > cts."LatestTransactionCreatedAt"
            AND t."deletedAt" is null
            AND t."RefundTransactionId" IS NULL
            AND t."isRefund" IS NOT TRUE
            AND t."isInternal" IS NOT TRUE

          GROUP by t."CollectiveId"
        ) as t ON TRUE
      );
    `);
  },
};
