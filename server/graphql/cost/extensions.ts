/**
 * Cost hints that a field definition can declare through `extensions.cost`:
 *
 * ```ts
 * someField: {
 *   type: GraphQLString,
 *   extensions: { cost: { weight: 50 } },
 * }
 * ```
 *
 * The cost analyzer reads them through `getFieldCostExtension`, never directly, so that a malformed value
 * cannot break the analysis.
 */
import type { GraphQLField } from 'graphql';

interface FieldCostExtension {
  /** Own cost of the field, added once per parent item. Defaults to 1, or more for paginated fields. */
  weight?: number;
}

declare module 'graphql' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Must match the generics of the declaration we extend
  interface GraphQLFieldExtensions<_TSource, _TContext, _TArgs> {
    cost?: FieldCostExtension;
  }
}

const isNonNegativeFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

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
  const { weight } = cost as Record<string, unknown>;
  if (isNonNegativeFiniteNumber(weight)) {
    result.weight = weight;
  }

  return result;
};
