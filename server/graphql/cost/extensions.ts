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

interface FieldCostExtension {
  /** Own cost of the field, added once per parent item. Defaults to 1, or more for paginated fields. */
  weight?: number;
  /**
   * Number of items to count for a field that returns a list but takes no `limit`: a realistic upper bound of the
   * number of items it returns. On a field that returns a single object holding a list (a collection without
   * `limit`), it applies to the first list below, like a `limit` does. Ignored on fields that take a `limit`.
   *
   * It replaces the limit of an enclosing paginated field, so a list declared next to `nodes` in a collection
   * (`MemberOfCollection.roles`) is not multiplied by the page size. Use `PARENT_LIMIT` for lists that do have one
   * item per item of the page.
   */
  listSize?: number | typeof PARENT_LIMIT;
}

declare module 'graphql' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Must match the generics of the declaration we extend
  interface GraphQLFieldExtensions<_TSource, _TContext, _TArgs> {
    cost?: FieldCostExtension;
  }
}

const isNonNegativeFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Returns the valid entries of a field's `extensions.cost`. Invalid entries are dropped, so the analyzer
 * falls back to its defaults for them.
 */
export const getFieldCostExtension = (field: GraphQLField<unknown, unknown>): FieldCostExtension => {
  const cost: unknown = field?.extensions?.cost;
  if (!cost || typeof cost !== 'object') {
    return {};
  }

  const result: FieldCostExtension = {};
  const { weight, listSize } = cost as Record<string, unknown>;
  if (isNonNegativeFiniteNumber(weight)) {
    result.weight = weight;
  }
  if (isNonNegativeInteger(listSize) || listSize === PARENT_LIMIT) {
    result.listSize = listSize;
  }

  return result;
};
