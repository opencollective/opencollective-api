/**
 * Cost hints that a field definition can declare through `extensions.cost`:
 *
 * ```ts
 * someStat: {
 *   type: GraphQLAmount,
 *   extensions: { cost: { weight: CostTier.Aggregate } },
 * }
 *
 * socialLinks: {
 *   type: new GraphQLList(GraphQLSocialLink),
 *   extensions: { cost: { listSize: 10 } },
 * }
 *
 * transactions: {
 *   type: new GraphQLNonNull(GraphQLTransactionCollection),
 *   args: { limit: collectionLimitArg(100) },
 *   extensions: { cost: { maxLimit: 10_000 } },
 * }
 *
 * // A weight or a list size can depend on the arguments of the field, see `CostArguments`
 * totalAmountReceived: {
 *   type: GraphQLAmount,
 *   args: { dateFrom: { type: GraphQLDateTime } },
 *   extensions: { cost: { weight: args => (isArgumentSet(args.dateFrom) ? CostTier.Aggregate : CostTier.Query) } },
 * }
 * ```
 *
 * The cost analyzer reads them through `getFieldCostExtension`, never directly, so that a malformed value
 * cannot break the analysis.
 */
import type { GraphQLField } from 'graphql';

/**
 * `listSize` value for a list that has one item per item of the enclosing paginated field, like the `scores` of a
 * page of search results. The list takes the limit of that field, as `nodes` does in a collection.
 */
export const PARENT_LIMIT = 'parentLimit';

/**
 * Named weights for `extensions.cost.weight`. Pick the tier of the work the resolver does for one parent item:
 *
 * - `Default`: a plain property, or a relation batched by a loader. Fields without a weight get it.
 * - `Query`: one SQL query per parent (an unbatched relation, a lookup in a pre-aggregated view), or an aggregate
 *   for one account batched by a loader. Fields that take a `limit` get it by default.
 * - `Aggregate`: an aggregate over the transactions (or expenses, orders...) of one account, one query per parent.
 *   Also a host-wide aggregate batched by a loader.
 * - `Report`: a scan across a whole host or the platform: host stats, time series and reports, search.
 *
 * When the work depends on the arguments (a filter that misses a materialized view, a search term), declare a
 * function of the arguments that returns one of these tiers.
 *
 * A field batched by a loader takes the tier below the same work done once per parent, as its marginal cost is a
 * share of one query rather than a query of its own.
 *
 * The values were set from production resolver timings (see opencollective/opencollective#9083): each tier is about
 * an order of magnitude slower at p95 than the one below. Do not use other values, `test/server/graphql/cost` checks it.
 */
export const CostTier = {
  Default: 1,
  Query: 10,
  Aggregate: 100,
  Report: 1000,
} as const;

/** The weight used when a weight function fails: the highest tier */
export const MAX_COST_TIER: number = Math.max(...Object.values(CostTier));

/**
 * Arguments of a field, as the cost functions of `extensions.cost` receive them. The analyzer runs before execution
 * and without coercion (see `arguments.ts`), so the values are the ones sent by the client, unvalidated: an enum is
 * its name, a date is a string, a list can be a single value. Any value can be of any type, read them with the
 * parsers of `arguments.ts` (`isArgumentSet`, `parseDateArgument`...).
 *
 * An argument is present when the request sets it (to a literal, a variable or a variable default) or when the
 * schema has a default for it. Arguments that are not set and have no default are absent.
 */
export type CostArguments<TArgs = Record<string, unknown>> = { readonly [K in keyof TArgs]?: unknown };

/**
 * A cost that depends on the arguments of the field. It must be pure, fast and synchronous: it runs on every request
 * that selects the field. If it throws or returns an invalid value, the analyzer uses a fallback (see each property)
 * and reports it in `costFunctionErrors`.
 */
type CostFunction<TArgs, TResult> = (args: CostArguments<TArgs>) => TResult;

export interface FieldCostExtension<TArgs = Record<string, unknown>> {
  /**
   * Own cost of the field, added once per parent item. Defaults to 1, or more for paginated fields.
   *
   * A function of the arguments must return one of the `CostTier` values. When it fails, the weight is
   * `MAX_COST_TIER`.
   */
  weight?: number | CostFunction<TArgs, number>;
  /**
   * Number of items to count for a field that returns a list but takes no `limit`: a realistic upper bound of the
   * number of items it returns. On a field that returns a single object holding a list (a collection without
   * `limit`), it applies to the first list below, like a `limit` does. Ignored on fields that take a `limit`.
   *
   * It replaces the limit of an enclosing paginated field, so a list declared next to `nodes` in a collection
   * (`MemberOfCollection.roles`) is not multiplied by the page size. Use `PARENT_LIMIT` for lists that do have one
   * item per item of the page.
   *
   * A function of the arguments can return a size computed from them (the number of periods of a time series, the
   * length of a list argument). When it fails, the size is the `maxLimit` of the field, or `DEFAULT_MAX_LIMIT`.
   */
  listSize?: number | typeof PARENT_LIMIT | CostFunction<TArgs, number | typeof PARENT_LIMIT>;
  /**
   * Largest `limit` the field accepts, when it is not `DEFAULT_MAX_LIMIT`. A request above it is reported, then
   * rejected once `config.graphql.cost.maxLimit.reject` is on (root users are exempt). Also the number of items counted
   * when the limit cannot be determined. Ignored on fields that take no `limit`.
   *
   * Declare the same value on an interface field and on its implementations: `test/server/graphql/cost` checks it and
   * lists every field that declares one.
   */
  maxLimit?: number;
}

declare module 'graphql' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Must match the generics of the declaration we extend
  interface GraphQLFieldExtensions<_TSource, _TContext, _TArgs> {
    cost?: FieldCostExtension<_TArgs>;
  }
}

const isNonNegativeFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number => isNonNegativeInteger(value) && value > 0;

/** A valid value for `weight`, or for the result of a weight function */
export const isValidWeight = isNonNegativeFiniteNumber;

/** A valid value for `listSize`, or for the result of a list size function */
export const isValidListSize = (value: unknown): value is number | typeof PARENT_LIMIT =>
  isNonNegativeInteger(value) || value === PARENT_LIMIT;

/**
 * Returns the valid entries of a field's `extensions.cost`. Invalid entries are dropped, so the analyzer
 * falls back to its defaults for them. Functions are returned as they are: their results are checked when the
 * analyzer calls them.
 */
export const getFieldCostExtension = (field: GraphQLField<unknown, unknown>): FieldCostExtension => {
  const cost: unknown = field?.extensions?.cost;
  if (!cost || typeof cost !== 'object') {
    return {};
  }

  const result: FieldCostExtension = {};
  const { weight, listSize, maxLimit } = cost as Record<string, unknown>;
  if (isValidWeight(weight) || typeof weight === 'function') {
    result.weight = weight as FieldCostExtension['weight'];
  }
  if (isValidListSize(listSize) || typeof listSize === 'function') {
    result.listSize = listSize as FieldCostExtension['listSize'];
  }
  if (isPositiveInteger(maxLimit)) {
    result.maxLimit = maxLimit;
  }

  return result;
};
