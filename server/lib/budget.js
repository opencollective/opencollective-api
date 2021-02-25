import { get } from 'lodash';

import queries from '../lib/queries';
import models, { Op, sequelize } from '../models';

import { getFxRate } from './currency';

export async function getBalanceWithBlockedFunds(collective, { endDate } = {}) {
  endDate = endDate || new Date();
  const result = await queries.getBalances([collective.id], endDate);
  return get(result, '[0].balance') || 0;
}

export function getBalance(collective, { startDate, endDate, currency, version } = {}) {
  version = version || collective.settings?.budget?.version || 'v1';
  const column = version === 'v1' ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency';
  const fiscalHostOnly = version === 'v1' ? false : true;
  const bogusCurrencyHandling = version === 'v1' ? true : false;
  const excludeRefunds = false;
  return sumTransactions(collective, {
    startDate,
    endDate,
    currency,
    column,
    fiscalHostOnly,
    excludeRefunds,
    bogusCurrencyHandling,
  });
}

export function getTotalAmountReceived(collective, { startDate, endDate, currency, version } = {}) {
  version = version || collective.settings?.budget?.version || 'v1';
  const column = version === 'v1' ? 'amountInCollectiveCurrency' : 'amountInHostCurrency';
  const fiscalHostOnly = version === 'v1' ? false : true;
  const bogusCurrencyHandling = version === 'v1' ? true : false;
  return sumTransactions(collective, {
    startDate,
    endDate,
    currency,
    column,
    transactionType: 'CREDIT',
    fiscalHostOnly,
    bogusCurrencyHandling,
  });
}

export function getTotalNetAmountReceived(collective, { startDate, endDate, currency, version } = {}) {
  version = version || collective.settings?.budget?.version || 'v1';
  const column = version === 'v1' ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency';
  const fiscalHostOnly = version === 'v1' ? false : true;
  const bogusCurrencyHandling = version === 'v1' ? true : false;
  return sumTransactions(collective, {
    startDate,
    endDate,
    currency,
    column,
    transactionType: 'CREDIT',
    fiscalHostOnly,
    bogusCurrencyHandling,
  });
}

async function sumTransactions(
  collective,
  {
    column,
    startDate = null,
    endDate = null,
    currency = null,
    transactionType = null,
    excludeRefunds = true,
    fiscalHostOnly = true,
    bogusCurrencyHandling = false,
  } = {},
) {
  const groupBy = ['amountInHostCurrency', 'netAmountInHostCurrency'].includes(column) ? 'hostCurrency' : 'currency';

  const where = {
    CollectiveId: collective.id,
    HostCollectiveId: { [Op.not]: null },
  };
  if (transactionType) {
    where.type = transactionType;
  }
  if (startDate) {
    where.createdAt = where.createdAt || {};
    where.createdAt[Op.gte] = startDate;
  }
  if (endDate) {
    where.createdAt = where.createdAt || {};
    where.createdAt[Op.lt] = endDate;
  }
  if (excludeRefunds) {
    // Exclude refunded transactions
    where.RefundTransactionId = { [Op.is]: null };
  }
  if (fiscalHostOnly) {
    // Only transactions that are marked under a Fiscal Host
    where.HostCollectiveId = { [Op.not]: null };
  }

  const results = await models.Transaction.findAll({
    attributes: [
      groupBy,
      [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount')), 0), 'amountInCollectiveCurrency'],
      [
        sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('netAmountInCollectiveCurrency')), 0),
        'netAmountInCollectiveCurrency',
      ],
      [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amountInHostCurrency')), 0), 'amountInHostCurrency'],
      [
        sequelize.fn(
          'COALESCE',
          sequelize.literal(
            'SUM(COALESCE("amountInHostCurrency", 0)) + SUM(COALESCE("platformFeeInHostCurrency", 0)) + SUM(COALESCE("hostFeeInHostCurrency", 0)) + SUM(COALESCE("paymentProcessorFeeInHostCurrency", 0)) + SUM(COALESCE("taxAmount" * "hostCurrencyFxRate", 0))',
          ),
          0,
        ),
        'netAmountInHostCurrency',
      ],
    ],
    where,
    group: [groupBy],
    raw: true,
  });

  let total = 0;
  for (const result of results) {
    const value = result[column];

    // Emulate the buggy legacy currency handling
    // Don't do this at home kids ...
    if (bogusCurrencyHandling) {
      const fxRate = await getFxRate(collective.currency, currency || collective.currency);
      total += Math.round(value * fxRate);
      continue;
    }

    const fxRate = await getFxRate(result[groupBy], currency || collective.currency);
    total += Math.round(value * fxRate);
  }

  return total;
}

export async function getYearlyIncome(collective) {
  // Three cases:
  // 1) All active monthly subscriptions. Multiply by 12
  // 2) All one-time and yearly subscriptions
  // 3) All inactive monthly subscriptions that have contributed in the past

  // TODO: support netAmountInHostCurrency
  const result = await sequelize.query(
    `
      WITH "activeMonthlySubscriptions" as (
        SELECT DISTINCT d."SubscriptionId", t."netAmountInCollectiveCurrency"
        FROM "Transactions" t
        LEFT JOIN "Orders" d ON d.id = t."OrderId"
        LEFT JOIN "Subscriptions" s ON s.id = d."SubscriptionId"
        WHERE t."CollectiveId"=:CollectiveId
          AND t."RefundTransactionId" IS NULL
          AND s."isActive" IS TRUE
          AND s.interval = 'month'
          AND s."deletedAt" IS NULL
      )
      SELECT
        (SELECT
          COALESCE(SUM("netAmountInCollectiveCurrency"*12),0) FROM "activeMonthlySubscriptions")
        +
        (SELECT
          COALESCE(SUM(t."netAmountInCollectiveCurrency"),0) FROM "Transactions" t
          LEFT JOIN "Orders" d ON t."OrderId" = d.id
          LEFT JOIN "Subscriptions" s ON d."SubscriptionId" = s.id
          WHERE t."CollectiveId" = :CollectiveId
            AND t."RefundTransactionId" IS NULL
            AND t.type = 'CREDIT'
            AND t."deletedAt" IS NULL
            AND t."createdAt" > (current_date - INTERVAL '12 months')
            AND ((s.interval = 'year' AND s."isActive" IS TRUE AND s."deletedAt" IS NULL) OR s.interval IS NULL))
        +
        (SELECT
          COALESCE(SUM(t."netAmountInCollectiveCurrency"),0) FROM "Transactions" t
          LEFT JOIN "Orders" d ON t."OrderId" = d.id
          LEFT JOIN "Subscriptions" s ON d."SubscriptionId" = s.id
          WHERE t."CollectiveId" = :CollectiveId
            AND t."RefundTransactionId" IS NULL
            AND t.type = 'CREDIT'
            AND t."deletedAt" IS NULL
            AND t."createdAt" > (current_date - INTERVAL '12 months')
            AND s.interval = 'month' AND s."isActive" IS FALSE AND s."deletedAt" IS NULL)
        "yearlyIncome"
      `.replace(/\s\s+/g, ' '), // this is to remove the new lines and save log space.
    {
      replacements: { CollectiveId: collective.id },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  return parseInt(result[0].yearlyIncome, 10);
}
