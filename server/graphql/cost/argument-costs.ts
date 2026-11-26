/**
 * Cost functions for `extensions.cost`, shared by the fields whose cost depends on their arguments. See
 * opencollective/opencollective#9088.
 *
 * They receive the arguments unvalidated (see `CostArguments`), so they parse every value and treat anything they
 * do not understand as the most expensive reading that stays realistic.
 */
import { getListArgumentLength, isArgumentSet, parseDateArgument } from './arguments';
import type { CostArguments } from './extensions';
import { CostTier } from './extensions';
import { DEFAULT_MAX_LIMIT } from './limit';

type Args = CostArguments;

const DAY = 24 * 60 * 60 * 1000;

/** Approximate length of each `TimeUnit`, to count the periods of a time series */
const TIME_UNIT_DURATIONS: Record<string, number> = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY,
  WEEK: 7 * DAY,
  MONTH: 30 * DAY,
  QUARTER: 91 * DAY,
  YEAR: 365 * DAY,
};

/**
 * Number of periods when the date range is unknown and the time unit is picked by the resolver (`getTimeUnit` in
 * `TimeSeriesAmount.ts`): it picks a unit that keeps the series under 36 periods (36 months for up to 3 years),
 * except for ranges of more than 3 years, which get one period per year.
 */
const AUTOMATIC_TIME_UNIT_MAX_PERIODS = 36;

/** Start of the range when it is unknown: the creation date of the account, at the earliest when the platform started */
const PLATFORM_START = Date.UTC(2015, 0, 1);

/** Largest number of items counted for a time series or a list of metrics */
const MAX_SERIES_SIZE = DEFAULT_MAX_LIMIT;

const isTrue = (value: unknown): boolean => value === true;

/** Same thresholds as `getTimeUnit` in `TimeSeriesAmount.ts` */
const getAutomaticTimeUnit = (days: number): string => {
  if (days < 21) {
    return 'DAY';
  } else if (days < 90) {
    return 'WEEK';
  } else if (days < 365 * 3) {
    return 'MONTH';
  } else {
    return 'YEAR';
  }
};

interface TimeSeriesSizeOptions {
  /** Number of nodes per period, for series that have one node per label (kind, tag...) in each period */
  labels?: number;
  /** End of the range when `dateTo` is not set, relative to now. Defaults to now. */
  defaultDateToOffset?: number;
  /** Start of the range when `dateFrom` is not set, relative to now. Defaults to the creation of the account. */
  defaultDateFromOffset?: number;
}

/**
 * Number of periods of a time series between two dates, as the resolvers compute it: `timeUnit` if set, otherwise
 * picked from the length of the range. Returns `null` when the start of the range is unknown.
 */
const countPeriods = (dateFrom: Date | null, dateTo: Date, timeUnit: unknown): number | null => {
  // `Object.hasOwn`: a variable can hold anything, including inherited names like `constructor`
  const unit = typeof timeUnit === 'string' && Object.hasOwn(TIME_UNIT_DURATIONS, timeUnit) ? timeUnit : null;
  if (!dateFrom) {
    if (!unit) {
      return AUTOMATIC_TIME_UNIT_MAX_PERIODS;
    }
    // From the creation of the account, which can be as old as the platform
    return Math.ceil((dateTo.getTime() - PLATFORM_START) / TIME_UNIT_DURATIONS[unit]);
  }

  const range = Math.max(0, dateTo.getTime() - dateFrom.getTime());
  const actualUnit = unit ?? getAutomaticTimeUnit(range / DAY);
  return Math.ceil(range / TIME_UNIT_DURATIONS[actualUnit]);
};

/**
 * `listSize` of a field that returns a time series (`dateFrom`, `dateTo`, `timeUnit`, `periodInMonths`): the number
 * of nodes, one per period (and label) in the date range, up to `MAX_SERIES_SIZE`. Declare it on the field that takes
 * the arguments; the `nodes` of the time series take it with `PARENT_LIMIT`.
 */
export const getTimeSeriesListSize =
  ({ labels = 1, defaultDateToOffset = 0, defaultDateFromOffset }: TimeSeriesSizeOptions = {}) =>
  (args: Args): number => {
    const now = Date.now();
    let dateFrom = parseDateArgument(args.dateFrom);
    let dateTo = parseDateArgument(args.dateTo) ?? new Date(now + defaultDateToOffset);
    const periodInMonths = args.periodInMonths;
    if (typeof periodInMonths === 'number' && periodInMonths > 0) {
      // As in the resolvers: the last `periodInMonths` months, until now
      dateFrom = new Date(now - periodInMonths * TIME_UNIT_DURATIONS.MONTH);
      dateTo = new Date(now);
    } else if (!dateFrom && defaultDateFromOffset !== undefined) {
      dateFrom = new Date(now + defaultDateFromOffset);
    }

    const periods = countPeriods(dateFrom, dateTo, args.timeUnit);
    if (periods !== null && !Number.isFinite(periods)) {
      return MAX_SERIES_SIZE; // Dates out of range (huge `periodInMonths`): count the largest series
    }
    return Math.min(MAX_SERIES_SIZE, Math.max(1, periods) * labels);
  };

/**
 * `listSize` of a metrics source field (`Host.metrics.*`): the `rows` are capped by `input.limit` when set. Without it,
 * a query with no `groupBy` returns one row per bucket, or a single row without a bucket. An unknown `input` (a
 * variable missing from the CI report) counts as `maxRows`.
 */
export const getMetricsListSize =
  (maxRows: number) =>
  (args: Args): number => {
    if (!args.input || typeof args.input !== 'object') {
      return maxRows;
    }
    const input = args.input as Record<string, unknown>;
    const { limit } = input;
    if (typeof limit === 'number' && Number.isInteger(limit) && limit >= 0) {
      return Math.min(limit, maxRows);
    } else if (isArgumentSet(input.groupBy)) {
      return maxRows;
    } else if (!isArgumentSet(input.bucket)) {
      return 1;
    }

    const dateRange =
      input.dateRange && typeof input.dateRange === 'object' ? (input.dateRange as Record<string, unknown>) : {};
    const from = parseDateArgument(dateRange.from);
    const to = parseDateArgument(dateRange.to) ?? new Date();
    const periods = countPeriods(from, to, input.bucket);
    return Math.min(maxRows, Math.max(1, periods));
  };

/**
 * `listSize` of a field that returns one item per item of a list argument. When the argument is unknown (a required
 * variable missing from the CI report), counts `sizeWhenUnknown`.
 */
export const getListArgumentSize =
  (argName: string, { sizeWhenUnknown }: { sizeWhenUnknown: number }) =>
  (args: Args): number =>
    args[argName] === undefined ? sizeWhenUnknown : getListArgumentLength(args[argName]);

/**
 * Weight of the amounts of `AccountStats` (`totalAmountReceived`, `totalAmountSpent`...). Without filters, they read
 * the pre-aggregated views (`CurrentCollectiveTransactionStats`), batched by a loader: `Query`. A date range, a kind,
 * children or gift cards make them sum the transactions instead, one query per set of arguments: `Aggregate`.
 */
export const getAccountAmountWeight = (args: Args): number =>
  isArgumentSet(args.dateFrom) ||
  isArgumentSet(args.dateTo) ||
  isArgumentSet(args.periodInMonths) ||
  isArgumentSet(args.kind) ||
  isTrue(args.includeChildren) ||
  isTrue(args.includeGiftCards)
    ? CostTier.Aggregate
    : CostTier.Query;

/**
 * Weight of `AccountStats.balance`. Current and historical (`dateTo`) balances read materialized views, batched by a
 * loader: `Query`. Children make it sum the transactions: `Aggregate`.
 */
export const getAccountBalanceWeight = (args: Args): number =>
  isTrue(args.includeChildren) ? CostTier.Aggregate : CostTier.Query;

/**
 * Weight of the amounts of `HostStats`. Without a date range, they read the pre-aggregated views for all the hosted
 * accounts: `Aggregate`, like other host-wide lookups batched by a loader. A date range (or gift cards) makes them sum
 * the transactions of all the hosted accounts: `Report`.
 */
export const getHostAmountWeight = (args: Args): number =>
  isArgumentSet(args.dateFrom) || isArgumentSet(args.dateTo) || isTrue(args.includeGiftCards)
    ? CostTier.Report
    : CostTier.Aggregate;

/**
 * Weight of a collection that takes a `searchTerm`: a search matches text columns (often with `ILIKE` across joined
 * tables) rather than an index on the filters, so it moves the collection one tier up.
 */
export const getSearchCollectionWeight =
  (baseTier: number) =>
  (args: Args): number => {
    if (!isArgumentSet(args.searchTerm)) {
      return baseTier;
    }
    const tiers = Object.values(CostTier) as number[];
    return tiers.find(tier => tier > baseTier) ?? baseTier;
  };

/** Weight of a paginated collection that takes a `searchTerm`, see `getSearchCollectionWeight` */
export const searchCollectionWeight = getSearchCollectionWeight(CostTier.Query);
