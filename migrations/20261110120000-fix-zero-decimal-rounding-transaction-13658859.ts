'use strict';

import type { QueryInterface } from 'sequelize';

/**
 * Transaction #13658859 (KRW-hosted DEBIT of a USD platform billing expense) was created by
 * `Transaction.createDoubleEntry` with `amountInHostCurrency` rounded to cents of the opposite
 * side's currency (USD) instead of KRW: -1000 * 1346.619822 = -1346619.82 -> -1346620,
 * instead of -1346600 (zero-decimal currencies must be stored as multiples of 100).
 *
 * Flagged by `checkTransactionAmountsForZeroDecimalCurrencies`. Only this row is affected.
 */
const TRANSACTION_ID = 13658859;
const BAD_AMOUNT = -1346620;
const FIXED_AMOUNT = -1346600;
const DATA_KEY = 'amountInHostCurrencyBeforeMigration20261110120000';

module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(
      `
      UPDATE "Transactions"
      SET
        "amountInHostCurrency" = :fixedAmount,
        "data" = COALESCE("data", '{}') || jsonb_build_object(:dataKey, "amountInHostCurrency")
      WHERE "id" = :id
      AND "hostCurrency" = 'KRW'
      AND "amountInHostCurrency" = :badAmount
      AND "deletedAt" IS NULL
    `,
      { replacements: { id: TRANSACTION_ID, badAmount: BAD_AMOUNT, fixedAmount: FIXED_AMOUNT, dataKey: DATA_KEY } },
    );
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(
      `
      UPDATE "Transactions"
      SET
        "amountInHostCurrency" = ("data" ->> :dataKey)::integer,
        "data" = "data" - :dataKey
      WHERE "id" = :id
      AND "hostCurrency" = 'KRW'
      AND "amountInHostCurrency" = :fixedAmount
      AND ("data" ->> :dataKey)::integer = :badAmount
      AND "deletedAt" IS NULL
    `,
      { replacements: { id: TRANSACTION_ID, badAmount: BAD_AMOUNT, fixedAmount: FIXED_AMOUNT, dataKey: DATA_KEY } },
    );
  },
};
