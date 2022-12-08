import expenseStatus from '../constants/expense_status';
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
 - v1: sum by currency based on netAmountInCollectiveCurrency then convert to Collective's currency using the Fx Rate of the day - DEPRECATED
 - v2: sum by currency based on amountInHostCurrency then convert to Collective's currency using the Fx Rate of the day - CURRENT
 - v3: sum by currency based on amountInHostCurrency, limit to entries with a HostCollectiveId, then convert Collective's currency using the Fx Rate of the day
*/

export async function getBalanceAmount(
  collective,
  { startDate, endDate, currency, version, loaders, includeChildren } = {},
) {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  // Optimized version using loaders
  if (loaders && version === DEFAULT_BUDGET_VERSION && !startDate && !endDate && !includeChildren) {
    const result = await loaders.Collective.balance.load(collective.id);
    const fxRate = await getFxRate(result.currency, currency);
    return {
      value: Math.round(result.value * fxRate),
      currency,
    };
  }

  // TODO: refactor to latest implementation of sumCollectivesTransactions that is supporting includeChildren
  const collectiveIds = await getCollectiveIds(collective, includeChildren);

  const results = await sumCollectivesTransactions(collectiveIds, {
    startDate,
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

export async function getBalanceWithBlockedFundsAmount(
  collective,
  { startDate, endDate, currency, version, loaders } = {},
) {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  // Optimized version using loaders
  if (loaders && version === DEFAULT_BUDGET_VERSION) {
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
  });
}

export function getBalances(collectiveIds, { startDate, endDate, currency, version = DEFAULT_BUDGET_VERSION } = {}) {
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

export function getBalancesWithBlockedFunds(
  collectiveIds,
  { startDate, endDate, currency, version = DEFAULT_BUDGET_VERSION } = {},
) {
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

export async function getTotalAmountReceivedAmount(
  collective,
  { loaders, net, kind, startDate, endDate, includeChildren, version, currency } = {},
) {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  let result;

  const transactionArgs = {
    net,
    kind,
    startDate,
    endDate,
    includeChildren,
  };

  // Optimized version using loaders
  if (loaders && version === DEFAULT_BUDGET_VERSION) {
    const amountReceivedLoader = loaders.Collective.amountReceived.buildLoader(transactionArgs);
    result = await amountReceivedLoader.load(collective.id);
  } else {
    const results = await getSumCollectivesAmountReceived([collective.id], {
      ...transactionArgs,
      version,
    });
    // Coming from sumCollectivesTransactions, we're guaranteed to have only one result per Collective
    result = results[collective.id];
  }

  // There is no guaranteee on the currency of the result, so we have to convert to whatever we need (currency)
  const fxRate = await getFxRate(result.currency, currency);
  return {
    value: Math.round(result.value * fxRate),
    currency,
  };
}

export async function getTotalAmountSpentAmount(
  collective,
  { loaders, net, kind, startDate, endDate, includeChildren, includeGiftCards, version, currency } = {},
) {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  let result;

  const transactionArgs = {
    net,
    kind,
    startDate,
    endDate,
    includeChildren,
    includeGiftCards,
  };

  if (loaders && version === DEFAULT_BUDGET_VERSION && !net) {
    const amountSpentLoader = loaders.Collective.amountSpent.buildLoader(transactionArgs);
    result = await amountSpentLoader.load(collective.id);
  } else {
    const results = await getSumCollectivesAmountSpent([collective.id], {
      ...transactionArgs,
      version,
    });
    // Coming from sumCollectivesTransactions, we're guaranteed to have only one result per Collective
    result = results[collective.id];
  }

  // There is no guaranteee on the currency of the result, so we have to convert to whatever we need (currency)
  const fxRate = await getFxRate(result.currency, currency);
  return {
    value: Math.round(result.value * fxRate),
    currency,
  };
}

export function getSumCollectivesAmountSpent(
  collectiveIds,
  { net, kind, startDate, endDate, includeChildren, includeGiftCards, version = DEFAULT_BUDGET_VERSION } = {},
) {
  const column = ['v0', 'v1'].includes(version)
    ? net
      ? 'netAmountInCollectiveCurrency'
      : 'amountInCollectiveCurrency'
    : net
    ? 'netAmountInHostCurrency'
    : 'amountInHostCurrency';
  const transactionType = DEBIT;

  return sumCollectivesTransactions(collectiveIds, {
    column,
    transactionType,
    kind,
    startDate,
    endDate,
    includeChildren,
    includeGiftCards,
    excludeInternals: true,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
  });
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

export async function getContributionsAndContributorsCount(
  collective,
  { loaders, startDate, endDate, includeChildren } = {},
) {
  let result;

  if (loaders) {
    const contributionsAndContributorsCountLoader = loaders.Collective.contributionsAndContributorsCount.buildLoader({
      startDate,
      endDate,
      includeChildren,
    });
    result = await contributionsAndContributorsCountLoader.load(collective.id);
  } else {
    const results = await sumCollectivesTransactions([collective.id], {
      column: 'amountInHostCurrency', // one expected but doesn't matter
      transactionType: CREDIT,
      kind: ['CONTRIBUTION', 'ADDED_FUNDS'],
      startDate,
      endDate,
      includeChildren,
      extraAttributes: [
        [sequelize.fn('COUNT', sequelize.col('Transaction.id')), 'count'],
        [
          sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('Transaction.FromCollectiveId'))),
          'countDistinctFromCollective',
        ],
      ],
    });

    result = results[collective.id];
  }

  return { contributionsCount: result.count ?? 0, contributorsCount: result.countDistinctFromCollective ?? 0 };
}

export async function getTotalAmountReceivedTimeSeries(
  collective,
  { loaders, net, startDate, endDate, timeUnit, currency, version, includeChildren } = {},
) {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  let result;

  const transactionArgs = {
    net,
    startDate,
    endDate,
    includeChildren,
  };

  // Optimized version using loaders
  if (loaders && version === DEFAULT_BUDGET_VERSION) {
    const amountReceivedTimeSeriesLoader = loaders.Collective.amountReceivedTimeSeries.buildLoader(transactionArgs);
    result = await amountReceivedTimeSeriesLoader.load(collective.id);
  } else {
    const results = await getSumCollectivesAmountReceived([collective.id], {
      ...transactionArgs,
      version,
      groupByAttributes: [[sequelize.fn('DATE_TRUNC', timeUnit, sequelize.col('Transaction.createdAt')), 'date']],
    });

    result = results[collective.id];
  }

  const fxRate = await getFxRate(result.currency, currency);

  const nodes = result.groupBy.date
    ? Object.values(result.groupBy.date).map(node => ({
        date: node.date,
        amount: { value: Math.round(node.amount * fxRate), currency },
      }))
    : [];

  return {
    dateFrom: startDate,
    dateTo: endDate,
    timeUnit,
    nodes,
  };
}

export function getSumCollectivesAmountReceived(
  collectiveIds,
  {
    net = false,
    kind,
    startDate,
    endDate,
    includeChildren = false,
    version = DEFAULT_BUDGET_VERSION,
    groupByAttributes,
    extraAttributes,
  } = {},
) {
  const column = ['v0', 'v1'].includes(version)
    ? net
      ? 'netAmountInCollectiveCurrency'
      : 'amountInCollectiveCurrency'
    : net
    ? 'netAmountInHostCurrency'
    : 'amountInHostCurrency';
  const transactionType = net ? 'NET_CREDIT' : CREDIT;

  return sumCollectivesTransactions(collectiveIds, {
    column,
    transactionType,
    kind,
    startDate,
    endDate,
    includeChildren,
    excludeRefunds: false,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
    groupByAttributes,
    extraAttributes,
  });
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
    transactionType = null,
    kind = null,
    startDate = null,
    endDate = null,
    excludeRefunds = true,
    withBlockedFunds = false,
    hostCollectiveId = null,
    excludeInternals = false,
    includeGiftCards = false,
    includeChildren = false,
    groupByAttributes = [],
    extraAttributes = [],
  } = {},
) {
  const collectiveId = includeChildren
    ? sequelize.fn('COALESCE', sequelize.col('collective.ParentCollectiveId'), sequelize.col('collective.id'))
    : includeGiftCards
    ? sequelize.fn(
        'COALESCE',
        sequelize.col('Transaction.UsingGiftCardFromCollectiveId'),
        sequelize.col('Transaction.CollectiveId'),
      )
    : sequelize.col('Transaction.CollectiveId');

  const amountColumns = {
    amountInCollectiveCurrency: sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount')), 0),
    netAmountInCollectiveCurrency: sequelize.fn(
      'COALESCE',
      sequelize.fn('SUM', sequelize.col('netAmountInCollectiveCurrency')),
      0,
    ),
    amountInHostCurrency: sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amountInHostCurrency')), 0),
    netAmountInHostCurrency: sequelize.fn(
      'COALESCE',
      sequelize.literal(
        'SUM(COALESCE("amountInHostCurrency", 0)) + SUM(COALESCE("platformFeeInHostCurrency", 0)) + SUM(COALESCE("hostFeeInHostCurrency", 0)) + SUM(COALESCE("paymentProcessorFeeInHostCurrency", 0)) + SUM(COALESCE("taxAmount" * "hostCurrencyFxRate", 0))',
      ),
      0,
    ),
  };

  const currencyColumn = ['amountInHostCurrency', 'netAmountInHostCurrency'].includes(column)
    ? sequelize.col('Transaction.hostCurrency')
    : sequelize.col('Transaction.currency');

  const include = [];

  let where = {};

  if (ids) {
    if (includeChildren && includeGiftCards) {
      throw new Error('includeChildren is not supported together with includeGiftCards');
    }
    if (includeGiftCards) {
      where = {
        ...where,
        [Op.or]: {
          CollectiveId: ids,
          UsingGiftCardFromCollectiveId: ids,
        },
      };
    } else if (includeChildren) {
      include.push({
        model: models.Collective,
        as: 'collective',
        where: {
          [Op.or]: {
            id: ids,
            ParentCollectiveId: ids,
          },
        },
        attributes: [],
      });
      include.push({
        model: models.Collective,
        as: 'fromCollective',
        attributes: [],
      });
      where = {
        ...where,
        [Op.and]: [
          sequelize.literal(
            '(("collective"."id" = "fromCollective"."id") OR (COALESCE("collective"."ParentCollectiveId", "collective"."id") != COALESCE("fromCollective"."ParentCollectiveId", "fromCollective"."id")))',
          ),
        ],
      };
    } else {
      where.CollectiveId = ids;
    }
  }
  if (transactionType) {
    if (transactionType === 'NET_CREDIT') {
      where = {
        ...where,
        [Op.or]: [{ type: CREDIT }, { type: DEBIT, kind: 'HOST_FEE' }],
      };
    } else {
      where.type = transactionType;
    }
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

  const totals = {};

  // Initialize totals
  if (ids) {
    for (const CollectiveId of ids) {
      totals[CollectiveId] = { CollectiveId, currency: 'USD', value: 0 };
    }
  }

  const attributes = [
    [collectiveId, 'CollectiveId'],
    [currencyColumn, 'currency'],
    [amountColumns[column], column],
    ...extraAttributes,
    ...groupByAttributes,
  ];

  // An attribute can either be an array where the second value is the alias, or a single value which is the column name, so we need to extract the aliases/names
  const groupBy = groupByAttributes.map(attr => (Array.isArray(attr) ? attr[1] : attr));
  const extra = extraAttributes.map(attr => (Array.isArray(attr) ? attr[1] : attr));

  const group = [collectiveId, currencyColumn, ...groupBy];

  const results = await models.Transaction.findAll({
    attributes,
    where,
    include,
    group,
    raw: true,
  });

  for (const result of results) {
    const CollectiveId = result['CollectiveId'];
    const value = result[column];
    const currency = result['currency'];

    // Initialize Collective total
    if (!totals[CollectiveId]) {
      totals[CollectiveId] = { CollectiveId, currency: 'USD', value: 0 };
    }
    // If it's the first total collected, set the currency
    if (totals[CollectiveId].value === 0) {
      totals[CollectiveId].currency = currency;
    }

    const fxRate = await getFxRate(currency, totals[CollectiveId].currency);
    const amount = Math.round(value * fxRate);
    totals[CollectiveId].value += amount;

    // Add extra attributes if any
    for (const field of extra) {
      if (!totals[CollectiveId][field]) {
        totals[CollectiveId][field] = 0;
      }
      totals[CollectiveId][field] += result[field];
    }

    // Add grouped by if any, with amount and extra attributes
    for (const group of groupBy) {
      if (!totals[CollectiveId].groupBy) {
        totals[CollectiveId].groupBy = {};
      }
      if (!totals[CollectiveId].groupBy[group]) {
        totals[CollectiveId].groupBy[group] = {};
      }
      const key = result[group];
      if (!totals[CollectiveId].groupBy[group][key]) {
        totals[CollectiveId].groupBy[group][key] = { amount: 0, [group]: key };
      }
      totals[CollectiveId].groupBy[group][key].amount += amount;

      for (const field of extra) {
        if (!totals[CollectiveId].groupBy[group][key][field]) {
          totals[CollectiveId].groupBy[group][key][field] = 0;
        }
        totals[CollectiveId].groupBy[group][key][field] += result[field];
      }
    }
  }

  if (groupByAttributes.length && withBlockedFunds) {
    throw new Error('This is not supported');
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
        currencyColumn,
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
      group: ['CollectiveId', currencyColumn],
      raw: true,
    });

    for (const disputedTransaction of disputedTransactions) {
      const CollectiveId = disputedTransaction['CollectiveId'];
      const value = disputedTransaction[column];

      const fxRate = await getFxRate(disputedTransaction[currencyColumn], totals[CollectiveId].currency);
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
