import '../../server/env';

import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

async function checkDeletedCollectives() {
  const message = 'No Transactions without a matching Collective';

  const results = await sequelize.query(
    `SELECT COUNT(*) as count
     FROM "Transactions" t
     LEFT JOIN "Collectives" c
     ON c."id" = t."CollectiveId"
     WHERE t."deletedAt" IS NULL
     AND (c."deletedAt" IS NOT NULL OR c."id" IS NULL)`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    // Not fixable
    throw new Error(message);
  }
}

async function checkOrphanTransactions() {
  const message = 'No orphan Transaction without a primary Transaction (EXPENSE, CONTRIBUTION, ADDED_FUNDS)';

  const results = await sequelize.query(
    `SELECT COUNT(DISTINCT secondaryTransactions."TransactionGroup") as count
     FROM "Transactions" secondaryTransactions
     LEFT JOIN "Transactions" primaryTransactions
     ON primaryTransactions."TransactionGroup" = secondaryTransactions."TransactionGroup"
     AND primaryTransactions."deletedAt" IS NULL
     AND primaryTransactions."kind" IN ('EXPENSE', 'CONTRIBUTION', 'ADDED_FUNDS', 'BALANCE_TRANSFER', 'PREPAID_PAYMENT_METHOD')
     WHERE secondaryTransactions."kind" NOT IN ('EXPENSE', 'CONTRIBUTION', 'ADDED_FUNDS', 'BALANCE_TRANSFER', 'PREPAID_PAYMENT_METHOD')
     -- there are sometime issues WHERE PAYMENT_PROCESSOR_COVER end up with a different TransactionGroup
     -- this should be adressed separetely
     AND secondaryTransactions."kind" NOT IN ('PAYMENT_PROCESSOR_COVER', 'PAYMENT_PROCESSOR_DISPUTE_FEE')
     -- we have older entries with this issue
     -- for now, we just want to get alerts if this happen again in the future
     AND secondaryTransactions."createdAt" > '2024-01-01'
     AND secondaryTransactions."deletedAt" IS NULL
     AND primaryTransactions."id" IS NULL`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].count > 0) {
    // Not fixable
    throw new Error(message);
  }
}

async function checkUniqueUuid() {
  const message = 'No Transaction with duplicate UUID';

  const results = await sequelize.query(
    `SELECT "uuid"
     FROM "Transactions"
     WHERE "deletedAt" IS NULL
     GROUP BY "uuid"
     HAVING COUNT(*) > 1`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    // Not fixable
    throw new Error(message);
  }
}

async function checkUniqueTransactionGroup() {
  const message = 'No duplicate TransactionGroup';

  const results = await sequelize.query(
    `SELECT "TransactionGroup"
    FROM "Transactions"
    WHERE "kind" IN ('EXPENSE', 'CONTRIBUTION', 'ADDED_FUNDS', 'BALANCE_TRANSFER', 'PREPAID_PAYMENT_METHOD')
    AND "deletedAt" IS NULL
    GROUP BY "TransactionGroup"
    HAVING COUNT(*) > 2`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    // Not fixable
    throw new Error(message);
  }
}

async function checkPaidTransactionsWithHostCollectiveId() {
  const results = await sequelize.query(
    `
    SELECT *
    FROM "Transactions" t
    INNER JOIN "Collectives" c ON t."CollectiveId" = c."id"
    INNER JOIN "Orders" o ON t."OrderId" = o."id"
    LEFT JOIN "PaymentMethods" pm ON pm."id" = o."PaymentMethodId"
    WHERE t."kind" = 'CONTRIBUTION'
    AND t."type" = 'DEBIT'
    AND pm."service" IN ('stripe', 'paypal')
    AND c."type" != 'ORGANIZATION' AND c."type" != 'USER' AND c."approvedAt" IS NOT NULL AND c."isActive" IS TRUE
    AND t."RefundTransactionId" IS NULL
    AND t."description" NOT LIKE 'Refund of%'
    AND t."createdAt" > '2025-01-01'
    AND COALESCE(TRIM(BOTH '"'::text FROM (((c."settings" -> 'budget'::text) -> 'version'::text))::text), 'v2'::text) = 'v2'
    `,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    // Not fixable
    throw new Error('Found STRIPE/PAYPAL paid orders affecting Collective balances');
  }
}

async function checkWisePaidTransactions() {
  const results = await sequelize.query(
    `
    WITH
      d AS (
        SELECT
          e.id, e."createdAt", e.amount, e.currency, e.data #>> '{recipient,currency}' AS "recipientCurrency",
          c.currency AS "collectiveCurrency",
          t."amountInHostCurrency", t."hostCurrency", t."data" -> 'fxRates' AS "fxRates", e."data" -> 'quote' AS "quote"
        FROM
          "Expenses" e
          INNER JOIN "Transactions" t
          ON e.id = t."ExpenseId" AND t."deletedAt" IS NULL AND t.kind = 'EXPENSE' AND t.type = 'DEBIT'
          INNER JOIN "Collectives" c
          ON t."CollectiveId" = c.id AND c."deletedAt" IS NULL
          INNER JOIN "Collectives" h
          ON t."HostCollectiveId" = h.id AND h."deletedAt" IS NULL
        WHERE e."deletedAt" IS NULL
          AND e.data #>> '{recipient,currency}' != e.currency
          AND e.currency != t."hostCurrency"
          AND t."data" #>> '{expenseToHostFxRate}' IS NOT NULL
          AND e."createdAt" >= '2025-10-01'
        ORDER BY
          e.id DESC
        ),
      summary AS (
        SELECT
          *,
              ROUND(d.amount * ("fxRates" -> 'expenseToHost')::numeric) / "amountInHostCurrency" =
              -1 AS "Requested Value in Host Currency matches the debited amount",
              ROUND(d.amount * ("fxRates" -> 'expenseToPayoutMethod')::numeric) / (quote -> 'targetAmount')::numeric =
              100 AS "User receives requested amount"
        FROM d
        )
    SELECT count("Requested Value in Host Currency matches the debited amount") as request_value_matches, count("User receives requested amount") as "user_received_amount" FROM summary WHERE "Requested Value in Host Currency matches the debited amount" IS FALSE OR "User receives requested amount" IS FALSE
    `,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results[0].request_value_matches > 0 || results[0].user_received_amount > 0) {
    // Not fixable
    throw new Error('Found inconsistency in the amount sent or received in Wise paid expenses.');
  }
}

export const checks = [
  checkDeletedCollectives,
  checkOrphanTransactions,
  checkUniqueUuid,
  checkUniqueTransactionGroup,
  checkPaidTransactionsWithHostCollectiveId,
  checkWisePaidTransactions,
];

if (!module.parent) {
  runAllChecksThenExit(checks);
}
