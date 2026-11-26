/**
 * Resolves the `limit` argument of a field from the request, without running the full variable coercion of
 * graphql-js (its shape changed between graphql 16 and 17, and we only need one integer).
 */
import type { ConstValueNode, FieldNode, GraphQLArgument, ValueNode } from 'graphql';
import { Kind } from 'graphql';

import type { ArgumentSource, ResolveArgumentOptions } from './arguments';
import { findArgumentValue } from './arguments';

/** Largest value of the GraphQL `Int` type. Anything above cannot be a valid `limit`. */
const GRAPHQL_MAX_INT = 2147483647;

/** The maximum `limit` that collections accept, used when the requested limit cannot be determined. */
export const DEFAULT_MAX_LIMIT = 1000;

export type LimitSource =
  | ArgumentSource
  /** A value was found but it is not a valid integer (null, negative, float, string...) */
  | 'invalid'
  /** No value and no default */
  | 'missing';

interface ResolvedLimit {
  /** Number of items to count for the field. Falls back to `maxLimit` when the source is `invalid` or `missing`. */
  value: number;
  source: LimitSource;
}

interface ResolveLimitOptions extends ResolveArgumentOptions {
  /** Value to use when the limit is invalid or missing. Defaults to `DEFAULT_MAX_LIMIT`. */
  maxLimit?: number;
}

/**
 * A valid limit is a non-negative integer within the GraphQL `Int` range. Zero is accepted because it is a
 * legitimate way to only fetch `totalCount`.
 */
const parseLimitValue = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= GRAPHQL_MAX_INT ? value : null;
};

const parseLimitLiteral = (node: ValueNode | ConstValueNode): number | null => {
  return node?.kind === Kind.INT ? parseLimitValue(Number(node.value)) : null;
};

/**
 * Resolves the value of an integer argument (`limit` by default) in this order: literal value, request
 * variable, variable default, schema default. Never throws.
 */
export const resolveLimitArgument = (
  fieldNode: FieldNode,
  argDefinition: GraphQLArgument | undefined,
  { variables, variableDefinitions, maxLimit = DEFAULT_MAX_LIMIT }: ResolveLimitOptions = {},
): ResolvedLimit => {
  const found = findArgumentValue(fieldNode, argDefinition, argDefinition?.name ?? 'limit', {
    variables,
    variableDefinitions,
  });
  if (found.source === 'missing') {
    return { value: maxLimit, source: 'missing' };
  }

  const value = 'literal' in found ? parseLimitLiteral(found.literal) : parseLimitValue(found.value);
  return value === null ? { value: maxLimit, source: 'invalid' } : { value, source: found.source };
};
