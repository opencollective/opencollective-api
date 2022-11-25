import { difference } from 'lodash';

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

export async function getBalanceAmount(
  collective,
  { endDate, currency, version, loaders, includeChildren, fast = true, withBlockedFunds = false } = {},
) {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  // Optimized version using loaders
  if (version === DEFAULT_BUDGET_VERSION && !endDate && !includeChildren) {
    let result;
    if (loaders) {
      const loader = withBlockedFunds ? 'balanceWithBlockedFunds' : 'balance';
      result = await loaders.Collective[loader].load(collective.id);
    } else if (fast) {
      const results = await getCurrentFastBalances([collective.id], { withBlockedFunds });
      result = results[collective.id];
    }
    if (result) {
      const fxRate = await getFxRate(result.currency, currency);
      return {
        value: Math.round(result.value * fxRate),
        currency,
      };
    }
  }

  const collectiveIds = await getCollectiveIds(collective, includeChildren);

  const results = await sumCollectivesTransactions(collectiveIds, {
    endDate,
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    excludeRefunds: false,
    withBlockedFunds: withBlockedFunds,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
  });

  // Sum and convert to final currency
  const value = await sumTransactionsInCurrency(results, currency);

  return { value, currency };
}

export async function getBalances(collectiveIds, { withBlockedFunds = false, fast = true } = {}) {
  const version = DEFAULT_BUDGET_VERSION;

  const fastResults = fast ? await getCurrentFastBalances(collectiveIds, { withBlockedFunds, fast }) : {};
  const missingCollectiveIds = difference(collectiveIds.map(Number), Object.keys(fastResults).map(Number));

  if (missingCollectiveIds.length === 0) {
    return fastResults;
  }

  const results = await sumCollectivesTransactions(missingCollectiveIds, {
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    excludeRefunds: false,
    withBlockedFunds: withBlockedFunds,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
  });

  return { ...fastResults, ...results };
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
    where.isInternal = { [Op.not]: true };
  }
  if (kind) {
    where.kind = kind;
  }

  // Remove transactions that are disputed but not refunded yet
  if (withBlockedFunds) {
    where = {
      ...where,
      [Op.not]: {
        isDisputed: { [Op.eq]: true },
        RefundTransactionId: { [Op.eq]: null },
      },
    };
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
    if (startDate || endDate) {
      throw new Error('withBlockedFunds should not be used together with startDate or endDate');
    }

    const blockedFundsResults = await getBlockedFunds(ids);
    for (const collectiveId of ids) {
      if (blockedFundsResults[collectiveId]) {
        const { CollectiveId, currency, value } = blockedFundsResults[collectiveId];

        const fxRate = await getFxRate(currency, totals[CollectiveId].currency);
        totals[CollectiveId].value -= Math.round(value * fxRate);
      }
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
export async function getBlockedFunds(collectiveIds) {
  const blockedFundResults = await models.Expense.findAll({
    attributes: [
      'CollectiveId',
      'currency',
      [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount')), 0), 'amount'],
    ],
    where: {
      CollectiveId: { [Op.in]: collectiveIds },
      [Op.or]: [{ status: SCHEDULED_FOR_PAYMENT }, { status: PROCESSING }],
    },
    group: ['CollectiveId', 'currency'],
    raw: true,
  });

  const totals = {};

  // In case we have results in multiple currencies, we consolidate on the first currency found
  for (const result of blockedFundResults) {
    const collectiveId = result['CollectiveId'];

    // Initialize Collective total
    if (!totals[collectiveId]) {
      totals[collectiveId] = { CollectiveId: collectiveId, currency: result['currency'], value: 0 };
    }

    const fxRate = await getFxRate(result['currency'], totals[collectiveId].currency);
    totals[collectiveId].value += Math.round(result['amount'] * fxRate);
  }

  return totals;
}

// Get current balance for collective using a combination of speed and accuracy.
export async function getCurrentFastBalances(collectiveIds, { withBlockedFunds = false } = {}) {
  const fastResults = await sequelize.query(
    `SELECT *
    FROM "CurrentCollectiveBalance"
    WHERE "CollectiveId" IN (:collectiveIds)`,
    {
      replacements: { collectiveIds },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  const totals = {};

  for (const result of fastResults) {
    const CollectiveId = result['CollectiveId'];

    totals[CollectiveId] = { CollectiveId, currency: result['hostCurrency'], value: result['netAmountInHostCurrency'] };
    if (withBlockedFunds) {
      totals[CollectiveId].value -= result['disputedNetAmountInHostCurrency'];
    }
  }

  if (withBlockedFunds) {
    const blockedFundsResults = await getBlockedFunds(Object.keys(totals));
    for (const collectiveId of Object.keys(totals)) {
      if (blockedFundsResults[collectiveId]) {
        const { CollectiveId, currency, value } = blockedFundsResults[collectiveId];

        const fxRate = await getFxRate(currency, totals[CollectiveId].currency);
        totals[CollectiveId].value -= Math.round(value * fxRate);
      }
    }
  }

  return totals;
}
