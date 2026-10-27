import config from 'config';
import { difference, groupBy } from 'lodash';
import type { FindAttributeOptions } from 'sequelize';
import { QueryTypes } from 'sequelize';

import { CollectiveType } from '../constants/collectives';
import type { SupportedCurrency } from '../constants/currencies';
import expenseStatus from '../constants/expense-status';
import { TransactionTypes } from '../constants/transactions';
import type { Loaders } from '../graphql/loaders';
import models, { type Collective, Op, sequelize } from '../models';

import { getFxRate, roundCentsAmount } from './currency';
import { fillTimeSeriesWithNodes, parseToBoolean } from './utils';

const { CREDIT, DEBIT } = TransactionTypes;
const { PROCESSING, SCHEDULED_FOR_PAYMENT } = expenseStatus;

const DEFAULT_BUDGET_VERSION = 'v2';
// TODO: Replace DEFAULT_BUDGET_VERSION checks with FAST_BALANCE_SUPPORTED_VERSIONS throughout this file
const FAST_BALANCE_SUPPORTED_VERSIONS = ['v2', 'v3'];

const FAST_BALANCE = parseToBoolean(config.ledger.fastBalance);

type BudgetVersion = string;

type CurrencyAmount = {
  value: number;
  currency: SupportedCurrency;
};

type CollectiveAmount = CurrencyAmount & {
  CollectiveId: number;
};

type GroupedAmount = {
  amount: number;
  date?: Date;
} & Record<string, unknown>;

type CollectiveTotal = CollectiveAmount & {
  groupBy?: Record<string, Record<string, GroupedAmount>>;
  [key: string]: unknown;
};

type TotalsByCollective = Record<number, CollectiveTotal>;

type GroupByAttribute = [unknown, string] | string;

type DateRangeOptions = {
  startDate?: Date | null;
  endDate?: Date | null;
  includeChildren?: boolean;
};

type GetBalanceAmountOptions = {
  loaders?: Loaders | null;
  endDate?: Date | null;
  includeChildren?: boolean;
  withBlockedFunds?: boolean;
  version?: BudgetVersion | null;
  currency?: SupportedCurrency;
};

type GetBalancesOptions = {
  endDate?: Date | null;
  includeChildren?: boolean;
  withBlockedFunds?: boolean;
  version?: BudgetVersion;
  useMaterializedView?: boolean;
  loaders?: Loaders | null;
};

type GetBalancesWithVersionOptions = GetBalancesOptions;

type AmountOptions = DateRangeOptions & {
  loaders?: Loaders | null;
  net?: boolean;
  kind?: string | string[] | null;
  version?: BudgetVersion | null;
  currency?: SupportedCurrency;
};

type GetTotalAmountReceivedAmountOptions = AmountOptions & {
  useMaterializedView?: boolean;
};

type GetTotalAmountSpentAmountOptions = AmountOptions & {
  includeGiftCards?: boolean;
};

type GetSumCollectivesAmountSpentOptions = AmountOptions & {
  includeGiftCards?: boolean;
  groupByAttributes?: GroupByAttribute[];
};

type GetTotalAmountPaidExpensesOptions = {
  startDate?: Date | null;
  endDate?: Date | null;
  expenseType?: string | string[] | null;
  currency?: SupportedCurrency;
};

type GetContributionsAndContributorsCountOptions = DateRangeOptions & {
  loaders?: Loaders | null;
};

type GetTotalAmountReceivedTimeSeriesOptions = AmountOptions & {
  timeUnit?: string;
};

type GetTotalAmountSpentTimeSeriesOptions = GetTotalAmountReceivedTimeSeriesOptions & {
  absoluteAmounts?: boolean;
};

type GetBalanceTimeSeriesOptions = DateRangeOptions & {
  timeUnit?: string;
  currency?: SupportedCurrency;
  version?: BudgetVersion | null;
};

type GetSumCollectivesAmountReceivedOptions = AmountOptions & {
  useMaterializedView?: boolean;
  groupByAttributes?: GroupByAttribute[];
  extraAttributes?: GroupByAttribute[];
};

type GetTotalMoneyManagedAmountOptions = {
  endDate?: Date | null;
  collectiveIds?: number[] | null;
  currency?: SupportedCurrency;
  version?: BudgetVersion | null;
  loaders?: Loaders | null;
};

type SumCollectivesTransactionsOptions = {
  column?: string;
  transactionType?: string | null;
  kind?: string | string[] | null;
  startDate?: Date | null;
  endDate?: Date | null;
  excludeRefunds?: boolean;
  withBlockedFunds?: boolean;
  hostCollectiveId?: number | Record<symbol, unknown> | null;
  excludeInternals?: boolean;
  includeGiftCards?: boolean;
  includeChildren?: boolean;
  groupByAttributes?: GroupByAttribute[];
  extraAttributes?: GroupByAttribute[];
};

type GetYearlyBudgetAmountOptions = {
  loaders?: Loaders | null;
  currency?: SupportedCurrency;
};

type GetCurrentCollectiveBalancesOptions = {
  loaders?: Loaders | null;
  withBlockedFunds?: boolean;
};

type GetCurrentCollectiveTransactionStatsOptions = {
  loaders?: Loaders | null;
  column?: string;
};

type TimeSeriesAmountNode = {
  date: Date | string;
  amount: CurrencyAmount;
};

type TimeSeriesResult = {
  dateFrom?: Date | null;
  dateTo?: Date | null;
  timeUnit?: string;
  nodes: TimeSeriesAmountNode[];
};

type YearlyBudgetRow = {
  CollectiveId: number;
  currency: SupportedCurrency;
  amount: number;
};

type HistoricalBalanceRow = {
  CollectiveId: number;
  netAmountInHostCurrency: number;
  hostCurrency: SupportedCurrency;
};

type CurrentBalanceRow = HistoricalBalanceRow & {
  disputedNetAmountInHostCurrency: number;
};

type CurrentTransactionStatsRow = {
  CollectiveId: number;
  hostCurrency: SupportedCurrency;
} & Record<string, unknown>;

export async function sumTransactionsInCurrency(
  results: readonly object[] | Record<string | number, object>,
  currency: SupportedCurrency,
): Promise<number> {
  let total = 0;

  for (const result of Object.values(results)) {
    const resultCurrency = result['currency'] as SupportedCurrency;
    const resultValue = result['value'] as number;
    const fxRate = await getFxRate(resultCurrency, currency);
    total += roundCentsAmount(resultValue * fxRate, currency);
  }

  return total;
}

export async function getCollectiveIds(collective: Collective, includeChildren?: boolean): Promise<number[]> {
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
  collective: Collective,
  { loaders, endDate, includeChildren, withBlockedFunds, version, currency }: GetBalanceAmountOptions = {},
): Promise<CurrencyAmount> {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  let result: CollectiveAmount;

  const transactionArgs = {
    endDate,
    includeChildren,
    withBlockedFunds,
  };

  // Optimized version using loaders
  if (loaders && version === DEFAULT_BUDGET_VERSION) {
    const balanceLoader = loaders.Collective.balance.buildLoader(transactionArgs);
    result = (await balanceLoader.load(collective.id)) as CollectiveAmount;
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
    value: roundCentsAmount(result.value * fxRate, currency),
    currency,
  };
}

export async function getBalances(
  collectiveIds: number[] | readonly number[],
  {
    endDate = null,
    includeChildren = false,
    withBlockedFunds = false,
    version = DEFAULT_BUDGET_VERSION,
    useMaterializedView = FAST_BALANCE,
    loaders = null,
  }: GetBalancesOptions = {},
): Promise<TotalsByCollective> {
  // Note: Historical balances (endDate path) don't support withBlockedFunds - the slow path will throw
  // an error for that combination. We must not use the fast path in that case to preserve the error.
  const fastResults =
    useMaterializedView === true && !includeChildren
      ? endDate
        ? FAST_BALANCE_SUPPORTED_VERSIONS.includes(version) && !withBlockedFunds
          ? await getHistoricalCollectiveBalances(collectiveIds, endDate)
          : {}
        : version === DEFAULT_BUDGET_VERSION
          ? await getCurrentCollectiveBalances(collectiveIds, { loaders, withBlockedFunds })
          : {}
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

/**
 * Same as getBalances but uses each collective's budget version (from settings.budget.version)
 * instead of a single default. Required for Ready to Pay and other features where collectives
 * may have different budget versions (v2 vs v3).
 */
export async function getBalancesWithVersionPerCollective(
  collectiveIds: number[] | readonly number[],
  options: GetBalancesWithVersionOptions = {},
): Promise<TotalsByCollective> {
  if (!collectiveIds?.length) {
    return {};
  }

  const collectives = await models.Collective.findAll({
    where: { id: collectiveIds },
    attributes: ['id', 'settings'],
    raw: true,
  });

  const idsByVersion = groupBy(collectiveIds, id => {
    const collective = collectives.find(c => c.id === id);
    return collective?.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  });

  const allBalances: TotalsByCollective = {};
  for (const [version, ids] of Object.entries(idsByVersion)) {
    const balances = await getBalances(ids, { ...options, version });
    Object.assign(allBalances, balances);
  }

  return allBalances;
}

export async function getTotalAmountReceivedAmount(
  collective: Collective,
  {
    loaders,
    net,
    useMaterializedView,
    kind,
    startDate,
    endDate,
    includeChildren,
    version,
    currency,
  }: GetTotalAmountReceivedAmountOptions = {},
): Promise<CurrencyAmount> {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  let result: CollectiveAmount;

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
    result = (await amountReceivedLoader.load(collective.id)) as CollectiveAmount;
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
    value: roundCentsAmount(result.value * fxRate, currency),
    currency,
  };
}

export async function getTotalAmountSpentAmount(
  collective: Collective,
  {
    loaders,
    net,
    kind,
    startDate,
    endDate,
    includeChildren,
    includeGiftCards,
    version,
    currency,
  }: GetTotalAmountSpentAmountOptions = {},
): Promise<CurrencyAmount> {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  let result: CollectiveAmount;

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
    result = (await amountSpentLoader.load(collective.id)) as CollectiveAmount;
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
    value: roundCentsAmount(result.value * fxRate, currency),
    currency,
  };
}

export async function getSumCollectivesAmountSpent(
  collectiveIds: number[] | readonly number[],
  {
    net,
    kind,
    startDate,
    endDate,
    includeChildren,
    includeGiftCards,
    version = DEFAULT_BUDGET_VERSION,
    groupByAttributes,
    loaders = null,
  }: GetSumCollectivesAmountSpentOptions = {},
): Promise<TotalsByCollective> {
  const fastResults =
    version === DEFAULT_BUDGET_VERSION &&
    !kind &&
    !startDate &&
    !endDate &&
    !includeChildren &&
    !includeGiftCards &&
    !groupByAttributes?.length
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
  const transactionType = 'DEBIT_WITHOUT_CONTRIBUTIONS_HOST_FEE_AND_PAYMENT_PROCESSOR_FEE';

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
    groupByAttributes,
  });

  return { ...fastResults, ...results };
}

export async function getTotalAmountPaidExpenses(
  collective: Collective,
  { startDate, endDate, expenseType, currency }: GetTotalAmountPaidExpensesOptions = {},
): Promise<CurrencyAmount> {
  currency = currency || collective.currency;

  const where: {
    FromCollectiveId: number;
    status: string;
    type?: string | string[];
    createdAt?: Record<symbol, Date>;
  } = {
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
  collective: Collective,
  { loaders, startDate, endDate, includeChildren }: GetContributionsAndContributorsCountOptions = {},
): Promise<{ contributionsCount: number; contributorsCount: number }> {
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
  collective: Collective,
  {
    loaders,
    net,
    kind,
    startDate,
    endDate,
    timeUnit,
    currency,
    version,
    includeChildren,
  }: GetTotalAmountReceivedTimeSeriesOptions = {},
): Promise<TimeSeriesResult> {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  let result: CollectiveTotal;

  const transactionArgs = {
    net,
    kind,
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
    result = (await amountReceivedTimeSeriesLoader.load(collective.id)) as CollectiveTotal;
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
        amount: { value: roundCentsAmount(node.amount * fxRate, currency), currency },
      }))
    : [];

  return {
    dateFrom: startDate,
    dateTo: endDate,
    timeUnit,
    nodes,
  };
}

export async function getTotalAmountSpentTimeSeries(
  collective: Collective,
  {
    loaders,
    net,
    kind,
    startDate,
    endDate,
    timeUnit,
    currency,
    version,
    includeChildren,
    absoluteAmounts = true,
  }: GetTotalAmountSpentTimeSeriesOptions = {},
): Promise<TimeSeriesResult> {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  let result: CollectiveTotal;

  const transactionArgs = {
    net,
    kind,
    startDate,
    endDate,
    includeChildren,
  };

  // Optimized version using loaders
  if (loaders && version === DEFAULT_BUDGET_VERSION) {
    const amountSpentTimeSeriesLoader = loaders.Collective.amountSpentTimeSeries.buildLoader({
      ...transactionArgs,
      timeUnit,
    });
    result = (await amountSpentTimeSeriesLoader.load(collective.id)) as CollectiveTotal;
  } else {
    const results = await getSumCollectivesAmountSpent([collective.id], {
      ...transactionArgs,
      version,
      groupByAttributes: [[sequelize.fn('DATE_TRUNC', timeUnit, sequelize.col('Transaction.createdAt')), 'date']],
    });

    result = results[collective.id];
  }

  const fxRate = await getFxRate(result.currency, currency);

  const nodes = result.groupBy?.date
    ? Object.values(result.groupBy.date).map(node => {
        let value = roundCentsAmount(node.amount * fxRate, currency);
        if (absoluteAmounts) {
          value = Math.abs(value);
        }
        return {
          date: node.date,
          amount: { value, currency },
        };
      })
    : [];

  return {
    dateFrom: startDate,
    dateTo: endDate,
    timeUnit,
    nodes,
  };
}

export async function getBalanceTimeSeries(
  collective: Collective,
  { startDate, endDate, timeUnit, currency, version, includeChildren }: GetBalanceTimeSeriesOptions = {},
): Promise<TimeSeriesResult> {
  version = version || collective.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || collective.currency;

  const balanceTimeSeriesPromise = sumCollectivesTransactions([collective.id], {
    column: ['v0', 'v1'].includes(version) ? 'netAmountInCollectiveCurrency' : 'netAmountInHostCurrency',
    startDate,
    endDate,
    includeChildren,
    excludeRefunds: false,
    hostCollectiveId: version === 'v3' ? { [Op.not]: null } : null,
    groupByAttributes: [[sequelize.fn('DATE_TRUNC', timeUnit, sequelize.col('Transaction.createdAt')), 'date']],
  });

  const startingBalancePromise = startDate
    ? getBalanceAmount(collective, { endDate: startDate, includeChildren, version, currency })
    : Promise.resolve(undefined);

  const [balanceTimeSeries, startingBalance] = await Promise.all([balanceTimeSeriesPromise, startingBalancePromise]);
  const result = balanceTimeSeries[collective.id];

  const nodes = result.groupBy?.date
    ? (Object.values(result.groupBy.date) as Array<{ amount: number; date: Date }>)
    : [];
  const nodesWithAllDates = fillTimeSeriesWithNodes({
    nodes,
    startDate,
    endDate,
    timeUnit,
    initialData: { amount: 0 },
  });

  const fxRate = await getFxRate(result.currency, currency);

  let runningBalance = startingBalance?.value ?? 0;

  const nodesWithTotalBalance = nodesWithAllDates.map(node => {
    runningBalance += node.amount * fxRate;
    return {
      date: node.date,
      amount: { value: roundCentsAmount(runningBalance, currency), currency },
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
  collectiveIds: number[] | readonly number[],
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
  }: GetSumCollectivesAmountReceivedOptions = {},
): Promise<TotalsByCollective> {
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
  const transactionType = net ? 'CREDIT_WITH_CONTRIBUTIONS_HOST_FEE_AND_PAYMENT_PROCESSOR_FEE' : CREDIT;

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
  host: Collective,
  { endDate, collectiveIds, currency, version = null, loaders = null }: GetTotalMoneyManagedAmountOptions = {},
): Promise<CurrencyAmount> {
  version = version || host.settings?.budget?.version || DEFAULT_BUDGET_VERSION;
  currency = currency || host.currency;

  if (!collectiveIds) {
    const collectives = await host.getHostedCollectives({ attributes: ['id'], raw: true });
    collectiveIds = collectives.map(result => result.id);
    collectiveIds.push(host.id);
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
  ids: number[] | readonly number[],
  {
    column = '',
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
  }: SumCollectivesTransactionsOptions = {},
): Promise<TotalsByCollective> {
  const separatePaymentProcessorFees = parseToBoolean(config.ledger.separatePaymentProcessorFees) === true;

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
      where['CollectiveId'] = ids;
    }
  }
  if (transactionType) {
    // This is usually to calculate for money spent
    if (transactionType === 'DEBIT_WITHOUT_CONTRIBUTIONS_HOST_FEE_AND_PAYMENT_PROCESSOR_FEE') {
      where[Op.and] = where[Op.and] || [];
      // Include or not payment processor fee if it's net or not (if net include, if not not)
      if (['netAmountInCollectiveCurrency', 'netAmountInHostCurrency'].includes(column)) {
        where[Op.and].push({
          [Op.or]: [
            {
              type: DEBIT,
              [Op.not]: { [Op.and]: { kind: ['HOST_FEE', 'PAYMENT_PROCESSOR_FEE'], OrderId: { [Op.not]: null } } },
            },
            { type: CREDIT, kind: 'PAYMENT_PROCESSOR_COVER', OrderId: null },
          ],
        });
      } else {
        where[Op.and].push({ type: DEBIT, kind: { [Op.notIn]: ['HOST_FEE', 'PAYMENT_PROCESSOR_FEE'] } });
      }
      // This is usually to calculate for NET amount money received
    } else if (transactionType === 'CREDIT_WITH_CONTRIBUTIONS_HOST_FEE_AND_PAYMENT_PROCESSOR_FEE') {
      where = {
        ...where,
        [Op.or]: [
          // Get all credits except PAYMENT_PROCESSOR_COVER from expenses or before separate fees
          {
            type: CREDIT,
            [Op.not]: [
              {
                kind: 'PAYMENT_PROCESSOR_COVER',
                [Op.or]: {
                  OrderId: null,
                  ...(separatePaymentProcessorFees && { createdAt: { [Op.lt]: '2024-01-01' } }),
                },
              },
            ],
          },
          // Deduct host fees and payment processor fees that are related to orders
          { type: DEBIT, kind: ['HOST_FEE', 'PAYMENT_PROCESSOR_FEE'], OrderId: { [Op.not]: null } },
        ],
      };
    } else {
      where['type'] = transactionType;
    }
  }
  if (startDate) {
    where['createdAt'] = where['createdAt'] || {};
    where['createdAt'][Op.gte] = startDate;
  }
  if (endDate) {
    where['createdAt'] = where['createdAt'] || {};
    where['createdAt'][Op.lt] = endDate;
  }
  if (excludeRefunds) {
    where[Op.and] = where[Op.and] || [];
    // Exclude refunded transactions
    where[Op.and].push({ RefundTransactionId: { [Op.is]: null } });
    // Also exclude anything with isRefund=true (PAYMENT_PROCESSOR_COVER doesn't have RefundTransactionId set)
    if (
      separatePaymentProcessorFees &&
      transactionType === 'CREDIT_WITH_CONTRIBUTIONS_HOST_FEE_AND_PAYMENT_PROCESSOR_FEE'
    ) {
      where[Op.and].push({ [Op.or]: [{ isRefund: { [Op.not]: true } }, { kind: 'PAYMENT_PROCESSOR_COVER' }] });
    } else if (
      separatePaymentProcessorFees &&
      transactionType === 'DEBIT_WITHOUT_CONTRIBUTIONS_HOST_FEE_AND_PAYMENT_PROCESSOR_FEE'
    ) {
      where[Op.and].push({ [Op.or]: [{ isRefund: { [Op.not]: true } }, { kind: 'PAYMENT_PROCESSOR_COVER' }] });
    } else {
      where[Op.and].push({ isRefund: { [Op.not]: true } });
    }
  }

  if (hostCollectiveId) {
    // Only transactions that are marked under a Fiscal Host
    where['HostCollectiveId'] = hostCollectiveId;
  }
  if (excludeInternals) {
    // Exclude internal transactions (we can tag some Transactions like "Switching Host" as internal)
    where['isInternal'] = { [Op.not]: true };
  }
  if (kind) {
    where['kind'] = kind;
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

  const totals: TotalsByCollective = {};

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
  ] as FindAttributeOptions;

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
    // Ordering by latest transaction date makes sure we aggregate amounts in the currency of the latest transaction when aggregating below (to avoid converting back and forth between currencies)
    order: [[sequelize.literal('MAX("Transaction"."createdAt")'), 'DESC']],
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

    const targetCurrency = totals[CollectiveId].currency;
    const fxRate = await getFxRate(currency, targetCurrency);
    const amount = roundCentsAmount(value * fxRate, targetCurrency);
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
    const blockedFundsResults = await getBlockedExpenseFunds(ids);
    for (const collectiveId of ids) {
      if (blockedFundsResults[collectiveId]) {
        const { CollectiveId, currency, value } = blockedFundsResults[collectiveId];
        const targetCurrency = totals[CollectiveId].currency;
        const fxRate = await getFxRate(currency, targetCurrency);
        totals[CollectiveId].value -= roundCentsAmount(value * fxRate, targetCurrency);
      }
    }
  }

  return totals;
}

export async function getYearlyBudgetAmount(
  collective: Collective,
  { loaders, currency }: GetYearlyBudgetAmountOptions = {},
): Promise<CurrencyAmount> {
  currency = currency || collective.currency;

  let result: CollectiveAmount;

  // Optimized version using loaders
  if (loaders) {
    result = (await loaders.Collective.yearlyBudget.load(collective.id)) as CollectiveAmount;
  } else {
    const results = await getYearlyBudgets([collective.id]);
    // we're guaranteed to have only one result per Collective
    result = results[collective.id];
  }

  // There is no guaranteee on the currency of the result, so we have to convert to whatever we need
  const fxRate = await getFxRate(result.currency, currency);
  return {
    value: roundCentsAmount(result.value * fxRate, currency),
    currency,
  };
}

export async function getYearlyBudgets(collectiveIds: number[] | readonly number[]): Promise<TotalsByCollective> {
  // 1) Active Recurring Contributions
  //   a) All active monthly contributions. Multiply by 12.
  //   b) All active yearly contributions
  // 2) Past Year Contributions
  //   a) All one-time contributions in the past year.
  //   b) All inactive recurring contributions that have contributed in the past year.

  const results = await sequelize.query<YearlyBudgetRow>(
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
            AND t."isInternal" IS FALSE
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
      type: QueryTypes.SELECT,
    },
  );

  const totals: TotalsByCollective = {};

  // In case we have results in multiple currencies, we consolidate on the first currency found
  for (const result of results) {
    const collectiveId = result['CollectiveId'];

    // Initialize Collective total
    if (!totals[collectiveId]) {
      totals[collectiveId] = { CollectiveId: collectiveId, currency: result['currency'], value: 0 };
    }

    const targetCurrency = totals[collectiveId].currency;
    const fxRate = await getFxRate(result['currency'], targetCurrency);
    totals[collectiveId].value += roundCentsAmount(result['amount'] * fxRate, targetCurrency);
  }

  for (const CollectiveId of collectiveIds) {
    if (!totals[CollectiveId]) {
      totals[CollectiveId] = { CollectiveId, currency: 'USD', value: 0 };
    }
  }

  return totals;
}

/**
 * Calculate the total "blocked funds" for each collective
 * Expenses that are PROCESSING or SCHEDULED_FOR_PAYMENT are considered "blocked funds"
 */
export async function getBlockedExpenseFunds(collectiveIds: number[] | readonly number[]): Promise<TotalsByCollective> {
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

  const totals: TotalsByCollective = {};

  // In case we have results in multiple currencies, we consolidate on the first currency found
  for (const result of blockedFundResults) {
    const collectiveId = result['CollectiveId'];

    // Initialize Collective total
    if (!totals[collectiveId]) {
      totals[collectiveId] = { CollectiveId: collectiveId, currency: result['currency'], value: 0 };
    }

    const targetCurrency = totals[collectiveId].currency;
    const fxRate = await getFxRate(result['currency'], targetCurrency);
    totals[collectiveId].value += roundCentsAmount(result['amount'] * fxRate, targetCurrency);
  }

  return totals;
}

/** The number of contributions that are blocked due to a dispute. */
export async function getBlockedContributionsCount(collectiveId: number): Promise<number> {
  return models.Transaction.count({
    where: {
      type: 'CREDIT',
      CollectiveId: collectiveId,
      kind: 'CONTRIBUTION',
      isDisputed: true,
      RefundTransactionId: null,
    },
  });
}

// Get historical balance for collectives at a specific point in time using TransactionBalances materialized view.
// Note: No separate loader needed - batching is handled by the existing `balance` loader in getBalances().
export async function getHistoricalCollectiveBalances(
  collectiveIds: number[] | readonly number[],
  endDate: Date,
): Promise<TotalsByCollective> {
  const results = await sequelize.query<HistoricalBalanceRow>(
    `-- DISTINCT ON is a PostgreSQL extension that returns the first row for each unique CollectiveId.
     -- Combined with ORDER BY CollectiveId, rank DESC, it returns the most recent balance per collective.
     -- We use rank (not createdAt) because rank is deterministic within a CollectiveId - it incorporates
     -- time ordering (10-second buckets), TransactionGroup, kind priority, and type priority.
     SELECT DISTINCT ON (tb."CollectiveId")
       tb."CollectiveId",
       tb."balance" as "netAmountInHostCurrency",
       tb."hostCurrency"
     FROM "TransactionBalances" tb
     INNER JOIN "Collectives" c ON tb."CollectiveId" = c."id"
       AND COALESCE(c."settings"->'budget'->>'version', 'v2') IN (:supportedBudgetVersions)
     WHERE tb."CollectiveId" IN (:collectiveIds)
       AND tb."createdAt" < :endDate
     ORDER BY tb."CollectiveId", tb."rank" DESC`,
    {
      replacements: { collectiveIds, endDate, supportedBudgetVersions: FAST_BALANCE_SUPPORTED_VERSIONS },
      type: QueryTypes.SELECT,
      raw: true,
    },
  );

  const totals: TotalsByCollective = {};

  for (const result of results) {
    const CollectiveId = result['CollectiveId'];
    totals[CollectiveId] = {
      CollectiveId,
      currency: result['hostCurrency'] as SupportedCurrency,
      value: result['netAmountInHostCurrency'],
    };
  }

  return totals;
}

// Get current balance for collective using a combination of speed and accuracy.
export async function getCurrentCollectiveBalances(
  collectiveIds: number[] | readonly number[],
  { loaders = null, withBlockedFunds = false }: GetCurrentCollectiveBalancesOptions = {},
): Promise<TotalsByCollective> {
  const fastResults = loaders
    ? await Promise.all(
        collectiveIds.map(collectiveId => loaders.Collective.currentCollectiveBalance.load(collectiveId)),
      ).then(results => results.filter(el => !!el))
    : await sequelize.query<CurrentBalanceRow>(
        `SELECT ccb.*
         FROM "CurrentCollectiveBalance" ccb
         INNER JOIN "Collectives" c ON ccb."CollectiveId" = c."id"
         AND COALESCE(c."settings"->'budget'->>'version', 'v2') = 'v2'
         WHERE ccb."CollectiveId" IN (:collectiveIds)`,
        {
          replacements: { collectiveIds },
          type: QueryTypes.SELECT,
          raw: true,
        },
      );

  const totals: TotalsByCollective = {};

  for (const result of fastResults) {
    const CollectiveId = result['CollectiveId'];

    totals[CollectiveId] = {
      CollectiveId,
      currency: result['hostCurrency'] as SupportedCurrency,
      value: result['netAmountInHostCurrency'],
    };
    if (withBlockedFunds) {
      totals[CollectiveId].value -= result['disputedNetAmountInHostCurrency'];
    }
  }

  if (withBlockedFunds) {
    const blockedFundsResults = await getBlockedExpenseFunds(Object.keys(totals).map(Number));
    for (const collectiveId of Object.keys(totals)) {
      if (blockedFundsResults[collectiveId]) {
        const { CollectiveId, currency, value } = blockedFundsResults[collectiveId];

        const targetCurrency = totals[CollectiveId].currency;
        const fxRate = await getFxRate(currency, targetCurrency);
        totals[CollectiveId].value -= roundCentsAmount(value * fxRate, targetCurrency);
      }
    }
  }

  return totals;
}

export async function getCurrentCollectiveTransactionStats(
  collectiveIds: number[] | readonly number[],
  { loaders = null, column }: GetCurrentCollectiveTransactionStatsOptions = {},
): Promise<TotalsByCollective> {
  const results = loaders
    ? await Promise.all(
        collectiveIds.map(collectiveId => loaders.Collective.currentCollectiveTransactionStats.load(collectiveId)),
      ).then(results => results.filter(el => !!el))
    : await sequelize.query<CurrentTransactionStatsRow>(
        `SELECT * FROM "CurrentCollectiveTransactionStats" WHERE "CollectiveId" IN (:collectiveIds)`,
        {
          replacements: { collectiveIds },
          type: QueryTypes.SELECT,
          raw: true,
        },
      );

  const totals: TotalsByCollective = {};

  for (const result of results) {
    const CollectiveId = result['CollectiveId'];
    totals[CollectiveId] = {
      CollectiveId,
      currency: result['hostCurrency'] as SupportedCurrency,
      value: result[column] as number,
    };
  }

  return totals;
}
