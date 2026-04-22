import '../../server/env';

import { QueryTypes } from 'sequelize';

import { ZERO_DECIMAL_CURRENCIES } from '../../server/constants/currencies';
import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

/**
 * Older transactions may have some issues that we don't have the time to fix right now.
 */
const START_DATE = '2025-01-01';

/**
 * For zero-decimal currencies (e.g. JPY), amounts in the DB are stored with the same ×100 multiplier
 * as regular currencies (e.g. ¥50 → 5000). A valid amount must therefore always be a multiple of 100
 * (the last two digits must be zero). This check detects Orders whose totalAmount or platformTipAmount
 * violates that invariant.
 */
async function checkOrderAmountsForZeroDecimalCurrencies() {
  const message = 'Orders with fractional amounts in zero-decimal currencies (last two digits should be zero)';

  const results = await sequelize.query<{
    id: number;
    currency: string;
    totalAmount: number;
    platformTipAmount: number;
  }>(
    `
    SELECT id, currency, "totalAmount", "platformTipAmount"
    FROM "Orders"
    WHERE "deletedAt" IS NULL
      AND currency IN (:zeroDecimalCurrencies)
      AND "createdAt" >= :startDate
      AND (
        "totalAmount" % 100 != 0
        OR ("platformTipAmount" IS NOT NULL AND "platformTipAmount" % 100 != 0)
      )
    ORDER BY "createdAt" DESC
    `,
    {
      type: QueryTypes.SELECT,
      raw: true,
      replacements: { zeroDecimalCurrencies: ZERO_DECIMAL_CURRENCIES, startDate: START_DATE },
    },
  );

  if (results.length > 0) {
    logger.warn(`Offending rows:\n${JSON.stringify(results, null, 2)}`);
    throw new Error(`${message} (found ${results.length})`);
  }
}

/**
 * For zero-decimal currencies, the Expense.amount must be a multiple of 100.
 */
async function checkExpenseAmountsForZeroDecimalCurrencies() {
  const message = 'Expenses with fractional amounts in zero-decimal currencies (last two digits should be zero)';

  const results = await sequelize.query<{ id: number; currency: string; amount: number }>(
    `
    SELECT id, currency, amount
    FROM "Expenses"
    WHERE "deletedAt" IS NULL
      AND currency IN (:zeroDecimalCurrencies)
      AND "createdAt" >= :startDate
      AND amount % 100 != 0
    ORDER BY "createdAt" DESC
    `,
    {
      type: QueryTypes.SELECT,
      raw: true,
      replacements: { zeroDecimalCurrencies: ZERO_DECIMAL_CURRENCIES, startDate: START_DATE },
    },
  );

  if (results.length > 0) {
    logger.warn(`Offending rows:\n${JSON.stringify(results, null, 2)}`);
    throw new Error(`${message} (found ${results.length})`);
  }
}

/**
 * For zero-decimal currencies, each ExpenseItem.amount must be a multiple of 100.
 */
async function checkExpenseItemAmountsForZeroDecimalCurrencies() {
  const message = 'ExpenseItems with fractional amounts in zero-decimal currencies (last two digits should be zero)';

  const results = await sequelize.query<{ id: number; currency: string; amount: number }>(
    `
    SELECT ei.id, ei.currency, ei.amount
    FROM "ExpenseItems" ei
    WHERE ei."deletedAt" IS NULL
      AND ei.currency IN (:zeroDecimalCurrencies)
      AND ei."createdAt" >= :startDate
      AND ei.amount % 100 != 0
    ORDER BY ei."createdAt" DESC
    `,
    {
      type: QueryTypes.SELECT,
      raw: true,
      replacements: { zeroDecimalCurrencies: ZERO_DECIMAL_CURRENCIES, startDate: START_DATE },
    },
  );

  if (results.length > 0) {
    logger.warn(`Offending rows:\n${JSON.stringify(results, null, 2)}`);
    throw new Error(`${message} (found ${results.length})`);
  }
}

async function checkTransactionAmountsForZeroDecimalCurrencies() {
  const message = 'Transactions with fractional amounts in zero-decimal currencies (last two digits should be zero)';
  const results = await sequelize.query<{ id: number; currency: string; amount: number }>(
    `
    select *
    from "Transactions"
    where "deletedAt" IS NULL
      AND "createdAt" >= :startDate
      AND (
        currency IN (:zeroDecimalCurrencies) AND amount % 100 != 0
        OR "hostCurrency" IN (:zeroDecimalCurrencies) AND "amountInHostCurrency" % 100 != 0
      )
    `,
    {
      type: QueryTypes.SELECT,
      raw: true,
      replacements: { zeroDecimalCurrencies: ZERO_DECIMAL_CURRENCIES, startDate: START_DATE },
    },
  );

  if (results.length > 0) {
    logger.warn(`Offending rows:\n${JSON.stringify(results, null, 2)}`);
    throw new Error(`${message} (found ${results.length})`);
  }
}

export const checks = [
  checkOrderAmountsForZeroDecimalCurrencies,
  checkExpenseAmountsForZeroDecimalCurrencies,
  checkExpenseItemAmountsForZeroDecimalCurrencies,
  checkTransactionAmountsForZeroDecimalCurrencies,
];

if (!module.parent) {
  runAllChecksThenExit(checks);
}
