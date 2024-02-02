'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
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
          AND ROUND(EXTRACT(epoch FROM t."createdAt" AT TIME ZONE 'UTC') / 10) > ROUND(EXTRACT(epoch FROM cbc."createdAt" AT TIME ZONE 'UTC') / 10)
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
};
