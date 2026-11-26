/**
 * Resolves the `limit` argument of a field from the request, without running the full variable coercion of
 * graphql-js (its shape changed between graphql 16 and 17, and we only need one integer).
 */
import type { ConstValueNode, FieldNode, GraphQLArgument, ValueNode, VariableDefinitionNode } from 'graphql';
import { Kind } from 'graphql';

/** Largest value of the GraphQL `Int` type. Anything above cannot be a valid `limit`. */
const GRAPHQL_MAX_INT = 2147483647;

/** The maximum `limit` that collections accept, used when the requested limit cannot be determined. */
export const DEFAULT_MAX_LIMIT = 1000;

export type LimitSource =
  /** Literal value in the document: `limit: 10` */
  | 'literal'
  /** Value of a request variable: `limit: $limit` with `{ "limit": 10 }` */
  | 'variable'
  /** Default value of the variable definition: `query ($limit: Int = 10)` */
  | 'variableDefault'
  /** Default value of the argument in the schema: `limit: Int! = 10` */
  | 'schemaDefault'
  /** A value was found but it is not a valid integer (null, negative, float, string...) */
  | 'invalid'
  /** No value and no default */
  | 'missing';

interface ResolvedLimit {
  /** Number of items to count for the field. Falls back to `maxLimit` when the source is `invalid` or `missing`. */
  value: number;
  source: LimitSource;
}

interface ResolveLimitOptions {
  /** Request variables, as received. Anything that is not a plain object is treated as no variables. */
  variables?: unknown;
  /** Variable definitions of the operation, by variable name */
  variableDefinitions?: ReadonlyMap<string, VariableDefinitionNode>;
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

const getSchemaDefault = (argDefinition: GraphQLArgument | undefined): { found: boolean; value: number | null } => {
  if (!argDefinition) {
    return { found: false, value: null };
  }

  // graphql 17: `default: { value }` or `default: { literal }`
  const defaultInput = argDefinition.default as { value?: unknown; literal?: ConstValueNode } | undefined;
  if (defaultInput) {
    if (defaultInput.literal) {
      return { found: true, value: parseLimitLiteral(defaultInput.literal) };
    } else if ('value' in defaultInput) {
      return { found: true, value: parseLimitValue(defaultInput.value) };
    }
  }

  // graphql 16 and legacy definitions
  if (argDefinition.defaultValue !== undefined) {
    return { found: true, value: parseLimitValue(argDefinition.defaultValue) };
  }

  return { found: false, value: null };
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
  const argName = argDefinition?.name ?? 'limit';
  const result = (value: number | null, source: LimitSource): ResolvedLimit =>
    value === null ? { value: maxLimit, source: 'invalid' } : { value, source };

  const argNode = fieldNode?.arguments?.find(arg => arg.name.value === argName);
  if (argNode) {
    if (argNode.value.kind !== Kind.VARIABLE) {
      return result(parseLimitLiteral(argNode.value), 'literal');
    }

    const variableName = argNode.value.name.value;
    if (variables && typeof variables === 'object' && Object.prototype.hasOwnProperty.call(variables, variableName)) {
      return result(parseLimitValue(variables[variableName]), 'variable');
    }

    const variableDefault = variableDefinitions?.get(variableName)?.defaultValue;
    if (variableDefault) {
      return result(parseLimitLiteral(variableDefault), 'variableDefault');
    }

    // A variable that is not provided and has no default leaves the argument unset: the schema default applies
  }

  const schemaDefault = getSchemaDefault(argDefinition);
  if (schemaDefault.found) {
    return result(schemaDefault.value, 'schemaDefault');
  }

  return { value: maxLimit, source: 'missing' };
};
