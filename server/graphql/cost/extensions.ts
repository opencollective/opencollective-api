/**
 * Cost hints that a field definition can declare through `extensions.cost`:
 *
 * ```ts
 * someField: {
 *   type: GraphQLString,
 *   extensions: { cost: { weight: 50 } },
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
