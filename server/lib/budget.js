import { isEmpty, isNil } from 'lodash';

import expenseStatus from '../constants/expense_status';
import { TransactionKind } from '../constants/transaction-kind';
import { TransactionTypes } from '../constants/transactions';
import models, { Op, sequelize } from '../models';

import { getFxRate } from './currency';

const { CREDIT, DEBIT } = TransactionTypes;
const { PROCESSING, SCHEDULED_FOR_PAYMENT } = expenseStatus;

const DEFAULT_BUDGET_VERSION = 'v2';

async function sumTransactionsInCurrency(results, currency) {
  let total = 0;

  for (const result of Object.values(results)) {
    const fxRate = await getFxRate(result.currency, currency);
    total += Math.round(result.value * fxRate);
  }

  return total;
}

export async function getCollectiveIds(collective, includeChildren) {
  if (!includeChildren) {
    return [collective.id];
  }

  const collectiveChildrenIds = await collective
    .getChildren({ attributes: ['id'] })
    .then(children => children.map(child => child.id));

  return [collective.id, ...collectiveChildrenIds];
}

/* Versions of the balance algorithm:
 - v0: sum everything in the netAmountInCollectiveCurrency column then assume it's in Collective's currency - DELETED
 - v1: sum by currency based on netAmountInCollectiveCurrency then convert to Collective's currency using the Fx Rate of the day
 - v2: sum by currency based on amountInHostCurrency then convert to Collective's currency using the Fx Rate of the day
 - v3: sum by currency based on amountInHostCurrency, limit to entries with a HostCollectiveId, then convert Collective's currency using the Fx Rate of the day
*/

export async function getBalanceAmount(collective, { endDate, currency, version, loaders, includeChildren } = {}) {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  // Optimized version using loaders
  if (version === DEFAULT_BUDGET_VERSION && !endDate && !includeChildren) {
    if (loaders) {
      const result = await loaders.Collective.balance.load(collective.id);
      const fxRate = await getFxRate(result.currency, currency);
      return {
        value: Math.round(result.value * fxRate),
        currency,
      };
    } else {
      return await getCurrentFastBalances(collective.id, collective.HostCollectiveId, currency, false);
    }
  }

  const collectiveIds = await getCollectiveIds(collective, includeChildren);

  const results = await sumCollectivesTransactions(collectiveIds, {
    endDate,
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    excludeRefunds: false,
    withBlockedFunds: false,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
  });

  // Sum and convert to final currency
  const value = await sumTransactionsInCurrency(results, currency);

  return { value, currency };
}

export async function getBalanceWithBlockedFundsAmount(collective, { currency, version, loaders } = {}) {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  // Optimized version using loaders
  if (version === DEFAULT_BUDGET_VERSION) {
    if (loaders) {
      const result = await loaders.Collective.balanceWithBlockedFunds.load(collective.id);
      const fxRate = await getFxRate(result.currency, currency);
      return {
        value: Math.round(result.value * fxRate),
        currency,
      };
    } else {
      return await getCurrentFastBalancesWithBlockedFunds(collective.id, collective.HostCollectiveId, currency);
    }
  }

  return sumCollectiveTransactions(collective, {
    currency: currency,
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    excludeRefunds: false,
    withBlockedFunds: true,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
  });
}

export function getBalances(collectiveIds) {
  const version = DEFAULT_BUDGET_VERSION;

  // TODO: what should the host id and currency be here?
  // const fetchResults = getCurrentFastBalances(collectiveIds, null, ??);
  // if (fetchResults.length === collectiveIds.length) {
  //   return fetchResults;
  // }

  return sumCollectivesTransactions(collectiveIds, {
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    excludeRefunds: false,
    withBlockedFunds: false,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
  });
}

// Only used by the loader?
export function getBalancesWithBlockedFunds(collectiveIds) {
  const version = DEFAULT_BUDGET_VERSION;

  // TODO: what should the host id and currency be here?
  // const fetchResults = getCurrentFastBalancesWithBlockedFunds(collectiveIds, null, ??);
  // if (fetchResults.length === collectiveIds.length) {
  //   return fetchResults;
  // }

  return sumCollectivesTransactions(collectiveIds, {
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    excludeRefunds: false,
    withBlockedFunds: true,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
  });
}

export async function getTotalAmountReceivedAmount(
  collective,
  { startDate, endDate, currency, version, kind, includeChildren } = {},
) {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  const collectiveIds = await getCollectiveIds(collective, includeChildren);

  const results = await sumCollectivesTransactions(collectiveIds, {
    startDate,
    endDate,
    column: ['v0', 'v1'].includes(version) ? 'amountInCollectiveCurrency' : 'amountInHostCurrency',
    transactionType: CREDIT,
    kind: kind,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
    excludeInternals: true,
    excludeCrossCollectiveTransactions: includeChildren,
  });

  // Sum and convert to final currency
  const value = await sumTransactionsInCurrency(results, currency);

  return { value, currency };
}

export async function getTotalAmountSpentAmount(
  collective,
  { startDate, endDate, currency, version, kind, includeChildren, net } = {},
) {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  const collectiveIds = await getCollectiveIds(collective, includeChildren);

  let column = ['v0', 'v1'].includes(version) ? 'amountInCollectiveCurrency' : 'amountInHostCurrency';
  if (net === true) {
    column = ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency';
  }

  const results = await sumCollectivesTransactions(collectiveIds, {
    startDate,
    endDate,
    column: column,
    transactionType: DEBIT,
    kind: kind,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
    excludeInternals: true,
    excludeCrossCollectiveTransactions: includeChildren,
    includeGiftCards: true,
  });

  // Sum and convert to final currency
  const value = await sumTransactionsInCurrency(results, currency);

  return { value, currency };
}

export async function getTotalAmountPaidExpenses(collective, { startDate, endDate, expenseType, currency } = {}) {
  currency = currency || collective.currency;

  const where = {
    FromCollectiveId: collective.id,
    status: 'PAID',
  };
  if (expenseType) {
    where.type = expenseType;
  }
  if (startDate) {
    where.createdAt = where.createdAt || {};
    where.createdAt[Op.gte] = startDate;
  }
  if (endDate) {
    where.createdAt = where.createdAt || {};
    where.createdAt[Op.lt] = endDate;
  }

  const results = await models.Expense.findAll({
    attributes: ['currency', [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount')), 0), 'value']],
    where: where,
    group: 'currency',
    raw: true,
  });

  // Sum and convert to final currency
  const value = await sumTransactionsInCurrency(results, currency);

  return { value, currency };
}

export async function getTotalNetAmountReceivedAmount(
  collective,
  { startDate, endDate, currency, version, includeChildren } = {},
) {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  const collectiveIds = await getCollectiveIds(collective, includeChildren);

  const creditResults = await sumCollectivesTransactions(collectiveIds, {
    startDate,
    endDate,
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    transactionType: CREDIT,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
    excludeInternals: true,
    excludeCrossCollectiveTransactions: includeChildren,
  });

  const creditTotal = await sumTransactionsInCurrency(creditResults, currency);

  const feesResults = await sumCollectivesTransactions(collectiveIds, {
    startDate,
    endDate,
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    transactionType: DEBIT,
    kind: TransactionKind.HOST_FEE,
    excludeInternals: true,
  });

  const feesTotal = await sumTransactionsInCurrency(feesResults, currency);

  return { value: creditTotal + feesTotal, currency };
}

export async function getTotalMoneyManagedAmount(host, { startDate, endDate, collectiveIds, currency, version } = {}) {
  version = version || host.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || host.currency;

  if (!collectiveIds) {
    const collectives = await host.getHostedCollectives({ attributes: ['id'] });
    collectiveIds = collectives.map(result => result.id);
    collectiveIds.push(host.id);
  }

  if (collectiveIds.length === 0) {
    return { value: 0, currency };
  }

  const results = await sumCollectivesTransactions(collectiveIds, {
    startDate,
    endDate,
    excludeRefunds: false,
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    hostCollectiveId: host.id,
  });

  // Sum and convert to final currency
  const value = await sumTransactionsInCurrency(results, currency);

  return { value, currency };
}

async function sumCollectiveTransactions(collective, options) {
  const results = await sumCollectivesTransactions([collective.id], options);

  const result = results[collective.id];

  if (options.currency) {
    const fxRate = await getFxRate(result.currency, options.currency);
    result.value = Math.round(result.value * fxRate);
    result.currency = options.currency;
  }

  return result;
}

export async function sumCollectivesTransactions(
  ids,
  {
    column,
    startDate = null,
    endDate = null,
    transactionType = null,
    excludeRefunds = true,
    withBlockedFunds = false,
    hostCollectiveId = null,
    excludeInternals = false,
    excludeCrossCollectiveTransactions = false,
    includeGiftCards = false,
    kind,
  } = {},
) {
  const groupBy = ['amountInHostCurrency', 'netAmountInHostCurrency'].includes(column) ? 'hostCurrency' : 'currency';

  let where = {};

  if (ids) {
    if (includeGiftCards) {
      where = {
        ...where,
        [Op.or]: {
          CollectiveId: ids,
          UsingGiftCardFromCollectiveId: ids,
        },
      };
    } else {
      where.CollectiveId = ids;
    }
    if (excludeCrossCollectiveTransactions) {
      where.FromCollectiveId = { [Op.notIn]: ids };
    }
  }
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
    // Also exclude anything with isRefund=true (PAYMENT_PROCESSOR_COVER doesn't have RefundTransactionId set)
    where.isRefund = { [Op.not]: true };
  }

  if (hostCollectiveId) {
    // Only transactions that are marked under a Fiscal Host
    where.HostCollectiveId = hostCollectiveId;
  }
  if (excludeInternals) {
    // Exclude internal transactions (we can tag some Transactions like "Switching Host" as internal)
    where.data = { internal: { [Op.not]: true } };
  }
  if (kind) {
    where.kind = kind;
  }

  const totals = {};

  // Initialize totals
  if (ids) {
    for (const CollectiveId of ids) {
      totals[CollectiveId] = { CollectiveId, currency: 'USD', value: 0 };
    }
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

    // Initialize Collective total
    if (!totals[CollectiveId]) {
      totals[CollectiveId] = { CollectiveId, currency: 'USD', value: 0 };
    }
    // If it's the first total collected, set the currency
    if (totals[CollectiveId].value === 0) {
      totals[CollectiveId].currency = result[groupBy];
    }

    const fxRate = await getFxRate(result[groupBy], totals[CollectiveId].currency);
    totals[CollectiveId].value += Math.round(value * fxRate);
  }

  if (withBlockedFunds) {
    // BLOCKED EXPENSES
    const blockedFundsWhere = {
      CollectiveId: ids,
      [Op.or]: [{ status: SCHEDULED_FOR_PAYMENT }, { status: PROCESSING }],
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

      // Initialize Collective total
      if (!totals[CollectiveId]) {
        totals[CollectiveId] = { CollectiveId, currency: 'USD', value: 0 };
      }
      // If it's the first total collected, set the currency
      if (totals[CollectiveId].value === 0) {
        totals[CollectiveId].currency = blockedFundResult['currency'];
      }

      const fxRate = await getFxRate(blockedFundResult['currency'], totals[CollectiveId].currency);
      totals[CollectiveId].value -= Math.round(value * fxRate);
    }

    // BLOCKED TRANSACTIONS
    const disputedTransactions = await models.Transaction.findAll({
      attributes: [
        'CollectiveId',
        groupBy,
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount')), 0), 'amountInCollectiveCurrency'],
        [
          sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('netAmountInCollectiveCurrency')), 0),
          'netAmountInCollectiveCurrency',
        ],
        [
          sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amountInHostCurrency')), 0),
          'amountInHostCurrency',
        ],
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
      // only consider disputed txs that don't have associated refunds
      where: { ...where, isDisputed: { [Op.eq]: true }, RefundTransactionId: { [Op.eq]: null } },
      group: ['CollectiveId', groupBy],
      raw: true,
    });

    for (const disputedTransaction of disputedTransactions) {
      const CollectiveId = disputedTransaction['CollectiveId'];
      const value = disputedTransaction[column];

      const fxRate = await getFxRate(disputedTransaction[groupBy], totals[CollectiveId].currency);
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
      SELECT
        (
          SELECT COALESCE(SUM(o."totalAmount"), 0) * 12
          FROM "Orders" o
          INNER JOIN "Subscriptions" s ON o."SubscriptionId" = s.id
          WHERE o."CollectiveId" = :CollectiveId
          AND o."deletedAt" IS NULL
          AND s."deletedAt" IS NULL
          AND s."isActive" IS TRUE
          AND s.interval = 'month'
        )
        +
        ( 
          SELECT COALESCE(SUM(o."totalAmount"), 0)
          FROM "Orders" o
          INNER JOIN "Subscriptions" s ON o."SubscriptionId" = s.id
          WHERE o."CollectiveId" = :CollectiveId
          AND o."deletedAt" IS NULL
          AND s."deletedAt" IS NULL
          AND s."isActive" IS TRUE
          AND s.interval = 'year'
        )
        +
        (
          SELECT COALESCE(SUM(t."netAmountInCollectiveCurrency"), 0)
          FROM "Transactions" t
          LEFT JOIN "Orders" d ON t."OrderId" = d.id
          LEFT JOIN "Subscriptions" s ON d."SubscriptionId" = s.id
          WHERE t."CollectiveId" = :CollectiveId
          AND t."RefundTransactionId" IS NULL
          AND t.type = 'CREDIT'
          AND t."deletedAt" IS NULL
          AND t."createdAt" > (current_date - INTERVAL '12 months')
          AND (s.id IS NULL OR s."isActive" IS FALSE)
        )
        AS "yearlyIncome"
      `.replace(/\s\s+/g, ' '), // this is to remove the new lines and save log space.
    {
      replacements: { CollectiveId: collective.id },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  return parseInt(result[0].yearlyIncome, 10);
}

// Calculate the total "blocked funds" for each collective
// Expenses that are PROCESSING or SCHEDULED_FOR_PAYMENT are considered "blocked funds"
export async function getCollectivesBlockedFunds(collectiveIds, hostId, currency) {
  const blockedFundsWhere = {
    CollectiveId: { [Op.in]: collectiveIds },
    [Op.or]: [{ status: SCHEDULED_FOR_PAYMENT }, { status: PROCESSING }],
  };

  if (hostId) {
    blockedFundsWhere.HostCollectiveId = hostId;
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

  const totals = {};
  for (const collectiveId of collectiveIds) {
    totals[collectiveId] = { CollectiveId: collectiveId, currency, value: 0 };
  }

  for (const blockedFundResult of blockedFundResults) {
    const collectiveId = blockedFundResult['CollectiveId'];
    const blockedFundValue = blockedFundResult['amount'];
    const blockedFundCurrency = blockedFundResult['currency'];

    const fxRate = await getFxRate(blockedFundCurrency, currency);
    totals[collectiveId].value += Math.round(blockedFundValue * fxRate);
  }

  return totals;
}

// Get current balance for collective using a combination of speed and accuracy.
// Uses CurrentCollectiveBalance view which sums recent transactions on top
// of the last materialized view checkpoint for a Collective's balance,
// ensuring that we get a fast response and one that is accurate
export async function getCurrentFastBalances(
  collectiveIds,
  hostCollectiveId,
  hostCurrency,
  removeBlockedFunds = false,
) {
  const collectivesBalances = await sequelize.query(
    `
    SELECT "CollectiveId",
      MAX("netAmountInHostCurrency") as "netAmountInHostCurrency",
      MAX("disputedNetAmountInHostCurrency") as "disputedNetAmountInHostCurrency"
    FROM "CurrentCollectiveBalance"
    WHERE "CollectiveId" IN (:collectiveIds)
    ${hostCollectiveId ? `AND "HostCollectiveId" = :hostCollectiveId` : ''}
    ${hostCurrency ? `AND "hostCurrency" = :hostCurrency` : ''}
    GROUP BY "CollectiveId";
  `,
    {
      replacements: { collectiveIds, hostCollectiveId, hostCurrency },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  const totals = {};
  for (const collectiveId of collectiveIds) {
    totals[collectiveId] = { CollectiveId: collectiveId, currency, value: 0 };
  }

  if (!isEmpty(collectivesBalances)) {
    // TODO: we should not enter this code block and fetch getCollectivesBlockedFunds at all if removeBlockedFunds is false
    const blockedFundsInHostCurrency = await getCollectivesBlockedFunds(collectiveIds, hostCollectiveId, currency);

    for (const collectiveBalances of collectivesBalances) {
      const { CollectiveId, netAmountInHostCurrency, disputedNetAmountInHostCurrency } = collectiveBalances;

      if (removeBlockedFunds) {
        totals[CollectiveId].value =
          netAmountInHostCurrency - disputedNetAmountInHostCurrency - blockedFundsInHostCurrency[CollectiveId].value;
      } else {
        totals[CollectiveId].value = netAmountInHostCurrency;
      }
    }
    console.log(totals);
    return totals;
  }

  return await sumCollectivesTransactions(collectiveIds, {
    column: 'netAmountInHostCurrency',
    excludeRefunds: false,
    withBlockedFunds: removeBlockedFunds,
    hostCollectiveId,
  });
}

export async function getCurrentFastBalancesWithBlockedFunds(collectiveIds, hostCollectiveId, currency) {
  return await getCurrentFastBalances(collectiveIds, hostCollectiveId, currency, true);
}
