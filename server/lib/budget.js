import config from 'config';
import { difference } from 'lodash';

import { CollectiveType } from '../constants/collectives';
import expenseStatus from '../constants/expense-status';
import { TransactionTypes } from '../constants/transactions';
import models, { Op, sequelize } from '../models';

import { getFxRate } from './currency';
import { fillTimeSeriesWithNodes, parseToBoolean } from './utils';

const { CREDIT, DEBIT } = TransactionTypes;
const { PROCESSING, SCHEDULED_FOR_PAYMENT } = expenseStatus;

const DEFAULT_BUDGET_VERSION = 'v2';

const FAST_BALANCE = parseToBoolean(config.ledger.fastBalance);

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
  { loaders, endDate, includeChildren, withBlockedFunds, version, currency } = {},
) {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  let result;

  const transactionArgs = {
    endDate,
    includeChildren,
    withBlockedFunds,
  };

  // Optimized version using loaders
  if (loaders && version === DEFAULT_BUDGET_VERSION) {
    const balanceLoader = loaders.Collective.balance.buildLoader(transactionArgs);
    result = await balanceLoader.load(collective.id);
  } else {
    const results = await getBalances([collective.id], {
      ...transactionArgs,
      version,
    });
    // Coming from sumCollectivesTransactions, we're guaranteed to have only one result per Collective
    result = results[collective.id];
  }

  // There is no guarantee on the currency of the result, so we have to convert to whatever we need
  const fxRate = await getFxRate(result.currency, currency);
  return {
    value: Math.round(result.value * fxRate),
    currency,
  };
}

export async function getBalances(
  collectiveIds,
  {
    endDate = null,
    includeChildren = false,
    withBlockedFunds = false,
    version = DEFAULT_BUDGET_VERSION,
    useMaterializedView = FAST_BALANCE,
    loaders = null,
  } = {},
) {
  const fastResults =
    useMaterializedView === true && version === DEFAULT_BUDGET_VERSION && !endDate && !includeChildren
      ? await getCurrentCollectiveBalances(collectiveIds, { loaders, withBlockedFunds })
      : {};
  const missingCollectiveIds = difference(collectiveIds.map(Number), Object.keys(fastResults).map(Number));

  if (missingCollectiveIds.length === 0) {
    return fastResults;
  }

  const results = await sumCollectivesTransactions(missingCollectiveIds, {
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    endDate,
    includeChildren,
    withBlockedFunds,
    excludeRefunds: false,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
  });

  return { ...fastResults, ...results };
}

export async function getTotalAmountReceivedAmount(
  collective,
  { loaders, net, useMaterializedView, kind, startDate, endDate, includeChildren, version, currency } = {},
) {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  let result;

  const transactionArgs = {
    net,
    useMaterializedView,
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

  // There is no guaranteee on the currency of the result, so we have to convert to whatever we need
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

  if (loaders && version === DEFAULT_BUDGET_VERSION) {
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

  // There is no guaranteee on the currency of the result, so we have to convert to whatever we need
  const fxRate = await getFxRate(result.currency, currency);
  return {
    value: Math.round(result.value * fxRate),
    currency,
  };
}

export async function getSumCollectivesAmountSpent(
  collectiveIds,
  {
    net,
    kind,
    startDate,
    endDate,
    includeChildren,
    includeGiftCards,
    version = DEFAULT_BUDGET_VERSION,
    loaders = null,
  } = {},
) {
  const fastResults =
    version === DEFAULT_BUDGET_VERSION && !kind && !startDate && !endDate && !includeChildren && !includeGiftCards
      ? await getCurrentCollectiveTransactionStats(collectiveIds, {
          loaders,
          column: net ? 'totalNetAmountSpentInHostCurrency' : 'totalAmountSpentInHostCurrency',
        })
      : {};
  const missingCollectiveIds = difference(collectiveIds.map(Number), Object.keys(fastResults).map(Number));

  if (missingCollectiveIds.length === 0) {
    return fastResults;
  }

  const column = ['v0', 'v1'].includes(version)
    ? net
      ? 'netAmountInCollectiveCurrency'
      : 'amountInCollectiveCurrency'
    : net
      ? 'netAmountInHostCurrency'
      : 'amountInHostCurrency';
  const transactionType = 'DEBIT_WITHOUT_HOST_FEE';

  const results = await sumCollectivesTransactions(missingCollectiveIds, {
    column,
    transactionType,
    kind,
    startDate,
    endDate,
    includeChildren,
    includeGiftCards,
    excludeRefunds: true, // default, make it explicit
    excludeInternals: true,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
  });

  return { ...fastResults, ...results };
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
    const amountReceivedTimeSeriesLoader = loaders.Collective.amountReceivedTimeSeries.buildLoader({
      ...transactionArgs,
      timeUnit,
    });
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

  const nodes = result.groupBy?.date
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

export async function getBalanceTimeSeries(
  collective,
  { startDate, endDate, timeUnit, currency, version, includeChildren } = {},
) {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  const promises = [];

  promises.push(
    sumCollectivesTransactions([collective.id], {
      column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
      startDate,
      endDate,
      includeChildren,
      excludeRefunds: false,
      hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
      groupByAttributes: [[sequelize.fn('DATE_TRUNC', timeUnit, sequelize.col('Transaction.createdAt')), 'date']],
    }),
  );

  if (startDate) {
    promises.push(getBalanceAmount(collective, { endDate: startDate, includeChildren, version, currency }));
  }

  const [balanceTimeSeries, startingBalance] = await Promise.all(promises);
  const result = balanceTimeSeries[collective.id];

  const nodes = result.groupBy?.date ? Object.values(result.groupBy.date) : [];
  const nodesWithAllDates = fillTimeSeriesWithNodes(nodes, startDate, endDate, timeUnit);

  const fxRate = await getFxRate(result.currency, currency);

  let runningBalance = startingBalance?.value ?? 0;

  const nodesWithTotalBalance = nodesWithAllDates.map(node => {
    runningBalance += node.amount * fxRate;
    return {
      date: node.date,
      amount: { value: Math.round(runningBalance), currency },
    };
  });

  return {
    dateFrom: startDate,
    dateTo: endDate,
    timeUnit,
    nodes: nodesWithTotalBalance,
  };
}

export async function getSumCollectivesAmountReceived(
  collectiveIds,
  {
    net = false,
    useMaterializedView = true,
    kind,
    startDate,
    endDate,
    includeChildren = false,
    version = DEFAULT_BUDGET_VERSION,
    groupByAttributes,
    extraAttributes,
    loaders = null,
  } = {},
) {
  const fastResults =
    useMaterializedView === true &&
    version === DEFAULT_BUDGET_VERSION &&
    !kind &&
    !startDate &&
    !endDate &&
    !includeChildren &&
    !groupByAttributes?.length &&
    !extraAttributes?.length
      ? await getCurrentCollectiveTransactionStats(collectiveIds, {
          loaders,
          column: net ? 'totalNetAmountReceivedInHostCurrency' : 'totalAmountReceivedInHostCurrency',
        })
      : {};
  const missingCollectiveIds = difference(collectiveIds.map(Number), Object.keys(fastResults).map(Number));

  if (missingCollectiveIds.length === 0) {
    return fastResults;
  }

  const column = ['v0', 'v1'].includes(version)
    ? net
      ? 'netAmountInCollectiveCurrency'
      : 'amountInCollectiveCurrency'
    : net
      ? 'netAmountInHostCurrency'
      : 'amountInHostCurrency';
  const transactionType = net ? 'CREDIT_WITH_HOST_FEE_AND_PAYMENT_PROCESSOR_FEE' : CREDIT;

  const results = await sumCollectivesTransactions(missingCollectiveIds, {
    column,
    transactionType,
    kind,
    startDate,
    endDate,
    includeChildren,
    excludeRefunds: true, // default, make it explicit
    excludeInternals: true,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
    groupByAttributes,
    extraAttributes,
  });

  return { ...fastResults, ...results };
}

export async function getTotalMoneyManagedAmount(
  host,
  { endDate, collectiveIds, currency, version, loaders = null } = {},
) {
  version = version || host.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || host.currency;

  if (!collectiveIds) {
    const hostedCollectiveIds = (await host.getHostedCollectives({ attributes: ['id'], raw: true })).map(c => c.id);
    const hostChildrenIds = (await host.getChildren({ attributes: ['id'], raw: true })).map(c => c.id);
    collectiveIds = [...hostedCollectiveIds, ...hostChildrenIds, host.id];
  }

  if (collectiveIds.length === 0) {
    return { value: 0, currency };
  }

  const fastResults =
    version === DEFAULT_BUDGET_VERSION && !endDate
      ? await getCurrentCollectiveBalances(collectiveIds, {
          loaders,
        })
      : {};

  const missingCollectiveIds = difference(collectiveIds.map(Number), Object.keys(fastResults).map(Number));

  if (missingCollectiveIds.length === 0) {
    // Sum and convert to final currency
    const value = await sumTransactionsInCurrency(fastResults, currency);

    return { value, currency };
  }

  const results = await sumCollectivesTransactions(missingCollectiveIds, {
    endDate,
    excludeRefunds: false,
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    hostCollectiveId: host.id,
  });

  // Sum and convert to final currency
  const value = await sumTransactionsInCurrency({ ...fastResults, ...results }, currency);

  return { value, currency };
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
  if (withBlockedFunds) {
    if (startDate || endDate || groupByAttributes.length) {
      throw new Error('withBlockedFunds is not supported together with startDate, endDate or groupByAttributes');
    }
  }
  if (includeChildren && includeGiftCards) {
    throw new Error('includeChildren is not supported together with includeGiftCards');
  }

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
          type: { [Op.ne]: CollectiveType.VENDOR },
        },
        attributes: [],
      });
      include.push({
        model: models.Collective,
        as: 'fromCollective',
        attributes: [],
      });
      if (excludeInternals) {
        where[Op.and] = where[Op.and] || [];
        where[Op.and].push(
          sequelize.literal(
            '(("collective"."id" = "fromCollective"."id") OR (COALESCE("collective"."ParentCollectiveId", "collective"."id") != COALESCE("fromCollective"."ParentCollectiveId", "fromCollective"."id")))',
          ),
        );
      }
    } else {
      where.CollectiveId = ids;
    }
  }
  if (transactionType) {
    // This is usually to calculate for money spent
    if (transactionType === 'DEBIT_WITHOUT_HOST_FEE') {
      where[Op.and] = where[Op.and] || [];
      // Include or not payment processor fee if it's net or not (if net include, if not not)
      if (['netAmountInCollectiveCurrency', 'netAmountInHostCurrency'].includes(column)) {
        where[Op.and].push({
          [Op.or]: [
            { type: DEBIT, kind: { [Op.notIn]: ['HOST_FEE'] } },
            { type: CREDIT, kind: 'PAYMENT_PROCESSOR_COVER' },
          ],
        });
      } else {
        where[Op.and].push({ type: DEBIT, kind: { [Op.notIn]: ['HOST_FEE', 'PAYMENT_PROCESSOR_FEE'] } });
      }
      // This is usually to calculate for NET amount money received
    } else if (transactionType === 'CREDIT_WITH_HOST_FEE_AND_PAYMENT_PROCESSOR_FEE') {
      where = {
        ...where,
        [Op.or]: [{ type: CREDIT }, { type: DEBIT, kind: 'HOST_FEE' }, { type: DEBIT, kind: 'PAYMENT_PROCESSOR_FEE' }],
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
    where[Op.and] = where[Op.and] || [];
    // Exclude refunded transactions
    where[Op.and].push({ RefundTransactionId: { [Op.is]: null } });
    // Also exclude anything with isRefund=true (PAYMENT_PROCESSOR_COVER doesn't have RefundTransactionId set)
    if (
      ['CREDIT_WITH_HOST_FEE_AND_PAYMENT_PROCESSOR_FEE', 'DEBIT_WITHOUT_HOST_FEE'].includes(transactionType) &&
      parseToBoolean(config.ledger.separatePaymentProcessorFees) === true
    ) {
      where[Op.and].push({ [Op.or]: [{ isRefund: { [Op.not]: true } }, { kind: 'PAYMENT_PROCESSOR_COVER' }] });
    } else {
      where[Op.and].push({ isRefund: { [Op.not]: true } });
    }
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

  if (withBlockedFunds) {
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

export async function getYearlyBudgetAmount(collective, { loaders, currency } = {}) {
  currency = currency || collective.currency;

  let result;

  // Optimized version using loaders
  if (loaders) {
    result = await loaders.Collective.yearlyBudget.load(collective.id);
  } else {
    const results = await getYearlyBudgets([collective.id]);
    // we're guaranteed to have only one result per Collective
    result = results[collective.id];
  }

  // There is no guaranteee on the currency of the result, so we have to convert to whatever we need
  const fxRate = await getFxRate(result.currency, currency);
  return {
    value: Math.round(result.value * fxRate),
    currency,
  };
}

export async function getYearlyBudgets(collectiveIds) {
  // 1) Active Recurring Contributions
  //   a) All active monthly contributions. Multiply by 12.
  //   b) All active yearly contributions
  // 2) Past Year Contributions
  //   a) All one-time contributions in the past year.
  //   b) All inactive recurring contributions that have contributed in the past year.

  const results = await sequelize.query(
    `
      WITH "ActiveRecurringContributions" as (
        SELECT
            o."CollectiveId",
            o."currency",
            (
              COALESCE(SUM(COALESCE(o."totalAmount", 0) - COALESCE(o."platformTipAmount", 0)) FILTER(WHERE o.interval = 'month'), 0) * 12
              +
              COALESCE(SUM(COALESCE(o."totalAmount", 0) - COALESCE(o."platformTipAmount", 0)) FILTER(WHERE o.interval = 'year'), 0)
            ) as "amount"
          FROM "Orders" o
          WHERE o."CollectiveId" IN (:CollectiveIds)
            AND o."deletedAt" IS NULL
            AND o."status" = 'ACTIVE'
          GROUP BY o."CollectiveId", o."currency"
      ),
      "PastYearContributions" as (
          SELECT
            t."CollectiveId",
            t."hostCurrency" as "currency",
            SUM(
              COALESCE(t."amountInHostCurrency", 0) +
              COALESCE(t."platformFeeInHostCurrency", 0) +
              COALESCE(t."hostFeeInHostCurrency", 0) +
              COALESCE(t."paymentProcessorFeeInHostCurrency", 0) +
              COALESCE(t."taxAmount" * t."hostCurrencyFxRate", 0)
            ) as "amount"
          FROM "Transactions" t
          INNER JOIN "Orders" o ON t."OrderId" = o.id
            AND o."status" != 'ACTIVE'
          WHERE t."CollectiveId" IN (:CollectiveIds)
            AND t."type" = 'CREDIT'
            AND t."kind" IN ('CONTRIBUTION', 'ADDED_FUNDS')
            AND t."deletedAt" IS NULL
            AND t."RefundTransactionId" IS NULL
            AND t."createdAt" > (current_date - INTERVAL '12 months')
          GROUP BY t."CollectiveId", t."hostCurrency"
      ),
      "CombinedContributions" as (
        SELECT * FROM "ActiveRecurringContributions"
        UNION ALL
        SELECT * FROM "PastYearContributions"
      )
      SELECT
        "CollectiveId", "currency", SUM("amount") as "amount"
      FROM "CombinedContributions"
      GROUP BY "CollectiveId", "currency";
      `,
    {
      replacements: { CollectiveIds: collectiveIds },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  const totals = {};

  // In case we have results in multiple currencies, we consolidate on the first currency found
  for (const result of results) {
    const collectiveId = result['CollectiveId'];

    // Initialize Collective total
    if (!totals[collectiveId]) {
      totals[collectiveId] = { CollectiveId: collectiveId, currency: result['currency'], value: 0 };
    }

    const fxRate = await getFxRate(result['currency'], totals[collectiveId].currency);
    totals[collectiveId].value += Math.round(result['amount'] * fxRate);
  }

  for (const CollectiveId of collectiveIds) {
    if (!totals[CollectiveId]) {
      totals[CollectiveId] = { CollectiveId, currency: 'USD', value: 0 };
    }
  }

  return totals;
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
export async function getCurrentCollectiveBalances(collectiveIds, { loaders = null, withBlockedFunds = false } = {}) {
  const fastResults = loaders
    ? await Promise.all(
        collectiveIds.map(collectiveId => loaders.Collective.currentCollectiveBalance.load(collectiveId)),
      ).then(results => results.filter(el => !!el))
    : await sequelize.query(`SELECT * FROM "CurrentCollectiveBalance" WHERE "CollectiveId" IN (:collectiveIds)`, {
        replacements: { collectiveIds },
        type: sequelize.QueryTypes.SELECT,
        raw: true,
      });

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

export async function getCurrentCollectiveTransactionStats(collectiveIds, { loaders = null, column } = {}) {
  const results = loaders
    ? await Promise.all(
        collectiveIds.map(collectiveId => loaders.Collective.currentCollectiveTransactionStats.load(collectiveId)),
      ).then(results => results.filter(el => !!el))
    : await sequelize.query(
        `SELECT * FROM "CurrentCollectiveTransactionStats" WHERE "CollectiveId" IN (:collectiveIds)`,
        {
          replacements: { collectiveIds },
          type: sequelize.QueryTypes.SELECT,
          raw: true,
        },
      );

  const totals = {};

  for (const result of results) {
    const CollectiveId = result['CollectiveId'];
    totals[CollectiveId] = { CollectiveId, currency: result['hostCurrency'], value: result[column] };
  }

  return totals;
}
