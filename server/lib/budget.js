import { sumBy } from 'lodash';

import expenseStatus from '../constants/expense_status';
import { TransactionTypes } from '../constants/transactions';
import models, { Op, sequelize } from '../models';

import { getFxRate } from './currency';

const { CREDIT } = TransactionTypes;
const { PROCESSING, SCHEDULED_FOR_PAYMENT } = expenseStatus;

/* Versions of the balance algorithm:
 - v0: sum everything in the netAmountInCollectiveCurrency column then assume it's in Collective's currency
 - v1: sum by currency based on netAmountInCollectiveCurrency then convert to Collective's currency using the Fx Rate of the day
 - v2: sum by currency based on amountInHostCurrency then convert to Collective's currency using the Fx Rate of the day
 - v3: sum by currency based on amountInHostCurrency, limit to entries with a HostCollectiveId, then convert Collective's currency using the Fx Rate of the day
*/

export async function getBalanceAmount(collective, { startDate, endDate, currency, version, loaders } = {}) {
  version = version || collective.settings?.budget?.version || 'v1';
  currency = currency || collective.currency;

  // Optimized version using loaders
  if (loaders && version === 'v1') {
    const result = await loaders.Collective.balance.load(collective.id);
    const fxRate = await getFxRate(result.currency, currency);
    return {
      value: Math.round(result.value * fxRate),
      currency,
    };
  }

  return sumCollectiveTransactions(collective, {
    startDate,
    endDate,
    currency,
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    excludeRefunds: false,
    withBlockedFunds: false,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
    bogusCurrencyHandling: version === 'v0' ? true : false,
  });
}

export async function getBalanceWithBlockedFundsAmount(
  collective,
  { startDate, endDate, currency, version, loaders } = {},
) {
  version = version || collective.settings?.budget?.version || 'v1';
  currency = currency || collective.currency;

  // Optimized version using loaders
  if (loaders && version === 'v1') {
    const result = await loaders.Collective.balanceWithBlockedFunds.load(collective.id);
    const fxRate = await getFxRate(result.currency, currency);
    return {
      value: Math.round(result.value * fxRate),
      currency,
    };
  }

  return sumCollectiveTransactions(collective, {
    startDate,
    endDate,
    currency: currency,
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    excludeRefunds: false,
    withBlockedFunds: true,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
    bogusCurrencyHandling: version === 'v0' ? true : false,
  });
}

export function getBalances(collectiveIds, { startDate, endDate, currency, version = 'v1' } = {}) {
  return sumCollectivesTransactions(collectiveIds, {
    startDate,
    endDate,
    currency,
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    excludeRefunds: false,
    withBlockedFunds: false,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
  });
}

export function getBalancesWithBlockedFunds(collectiveIds, { startDate, endDate, currency, version = 'v1' } = {}) {
  return sumCollectivesTransactions(collectiveIds, {
    startDate,
    endDate,
    currency,
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    excludeRefunds: false,
    withBlockedFunds: true,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
  });
}

export function getTotalAmountReceivedAmount(collective, { startDate, endDate, currency, version } = {}) {
  version = version || collective.settings?.budget?.version || 'v1';
  currency = currency || collective.currency;
  return sumCollectiveTransactions(collective, {
    startDate,
    endDate,
    currency,
    column: ['v0', 'v1'].includes(version) ? 'amountInCollectiveCurrency' : 'amountInHostCurrency',
    transactionType: CREDIT,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
  });
}

export function getTotalNetAmountReceivedAmount(collective, { startDate, endDate, currency, version } = {}) {
  version = version || collective.settings?.budget?.version || 'v1';
  currency = currency || collective.currency;
  return sumCollectiveTransactions(collective, {
    startDate,
    endDate,
    currency,
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    transactionType: CREDIT,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
  });
}

export async function getTotalMoneyManagedAmount(host, { startDate, endDate, currency, version } = {}) {
  version = version || host.settings?.budget?.version || 'v1';
  currency = currency || host.currency;

  const hostedCollectives = await host.getHostedCollectives();
  const ids = hostedCollectives.map(c => c.id);
  if (host.isActive) {
    ids.push(host.id);
  }
  if (ids.length === 0) {
    return { value: 0, currency };
  }

  const result = await sumCollectivesTransactions(ids, {
    startDate,
    endDate,
    currency,
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    hostCollectiveId: host.id,
  });

  return {
    value: sumBy(Object.values(result), 'value'),
    currency,
  };
}

async function sumCollectiveTransactions(collective, options) {
  const result = await sumCollectivesTransactions([collective.id], options);

  return result[collective.id];
}

async function sumCollectivesTransactions(
  ids,
  {
    column,
    currency = 'USD',
    startDate = null,
    endDate = null,
    transactionType = null,
    excludeRefunds = true,
    withBlockedFunds = false,
    hostCollectiveId = null,
    bogusCurrencyHandling = false,
  } = {},
) {
  const groupBy = ['amountInHostCurrency', 'netAmountInHostCurrency'].includes(column) ? 'hostCurrency' : 'currency';

  const where = {
    CollectiveId: ids,
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
  if (hostCollectiveId) {
    // Only transactions that are marked under a Fiscal Host
    where.HostCollectiveId = hostCollectiveId;
  }

  const totals = {};

  // Initialize total
  for (const CollectiveId of ids) {
    totals[CollectiveId] = totals[CollectiveId] || { CollectiveId, currency, value: 0 };
  }

  const results = await models.Transaction.findAll({
    attributes: [
      'CollectiveId',
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
    group: ['CollectiveId', groupBy],
    raw: true,
  });

  for (const result of results) {
    const CollectiveId = result['CollectiveId'];
    const value = result[column];

    // Emulate the buggy legacy currency handling
    if (bogusCurrencyHandling) {
      // Don't do this at home kids ...
      totals[CollectiveId].value += Math.round(value);
    } else {
      const fxRate = await getFxRate(result[groupBy], currency);
      totals[CollectiveId].value += Math.round(value * fxRate);
    }
  }

  if (withBlockedFunds) {
    const blockedFundsWhere = {
      CollectiveId: ids,
      [Op.or]: [{ status: SCHEDULED_FOR_PAYMENT }, { status: PROCESSING, 'data.payout_batch_id': { [Op.not]: null } }],
    };
    if (startDate) {
      blockedFundsWhere.createdAt = blockedFundsWhere.createdAt || {};
      blockedFundsWhere.createdAt[Op.gte] = startDate;
    }
    if (endDate) {
      blockedFundsWhere.createdAt = blockedFundsWhere.createdAt || {};
      blockedFundsWhere.createdAt[Op.lt] = endDate;
    }

    const blockedFundResults = await models.Expense.findAll({
      attributes: [
        'CollectiveId',
        'currency',
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount')), 0), 'amount'],
      ],
      where: blockedFundsWhere,
      group: ['CollectiveId', 'currency'],
      raw: true,
    });

    for (const blockedFundResult of blockedFundResults) {
      const CollectiveId = blockedFundResult['CollectiveId'];
      const value = blockedFundResult['amount'];

      const fxRate = await getFxRate(blockedFundResult['currency'], currency);
      totals[CollectiveId].value -= Math.round(value * fxRate);
    }
  }

  return totals;
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
