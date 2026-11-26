/**
 * Resolves the arguments of a field from the request, for the cost analyzer.
 *
 * It does not run the variable coercion of graphql-js: its shape changed between graphql 16 and 17, and the analyzer
 * runs before validation is known to have passed (in CI, it runs on documents that were never validated). The values
 * are returned as the client sent them, in their JSON form: an enum is its name, a `DateTime` is a string, an input
 * object is a plain object. Cost functions must therefore accept any value, see the parsers below.
 */
import type {
  ConstValueNode,
  FieldNode,
  GraphQLArgument,
  GraphQLField,
  ValueNode,
  VariableDefinitionNode,
} from 'graphql';
import { getNullableType, isEnumType, Kind, valueFromASTUntyped } from 'graphql';

export type ArgumentSource =
  /** Literal value in the document: `limit: 10` */
  | 'literal'
  /** Value of a request variable: `limit: $limit` with `{ "limit": 10 }` */
  | 'variable'
  /** Default value of the variable definition: `query ($limit: Int = 10)` */
  | 'variableDefault'
  /** Default value of the argument in the schema: `limit: Int! = 10` */
  | 'schemaDefault';

/** Where the value of an argument comes from, before parsing it */
type ArgumentValue =
  | { source: 'literal'; literal: ValueNode }
  | { source: 'variable'; value: unknown }
  | { source: 'variableDefault'; literal: ConstValueNode }
  | { source: 'schemaDefault'; literal: ConstValueNode }
  | { source: 'schemaDefault'; value: unknown }
  /** No value and no default */
  | { source: 'missing' };

export interface ResolveArgumentOptions {
  /** Request variables, as received. Anything that is not a plain object is treated as no variables. */
  variables?: unknown;
  /** Variable definitions of the operation, by variable name */
  variableDefinitions?: ReadonlyMap<string, VariableDefinitionNode>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasVariable = (variables: unknown, name: string): variables is Record<string, unknown> =>
  isPlainObject(variables) && Object.prototype.hasOwnProperty.call(variables, name);

const getSchemaDefault = (argDefinition: GraphQLArgument | undefined): ArgumentValue => {
  if (!argDefinition) {
    return { source: 'missing' };
  }

  // graphql 17: `default: { value }` or `default: { literal }`
  const defaultInput = argDefinition.default as { value?: unknown; literal?: ConstValueNode } | undefined;
  if (defaultInput) {
    if (defaultInput.literal) {
      return { source: 'schemaDefault', literal: defaultInput.literal };
    } else if ('value' in defaultInput) {
      return { source: 'schemaDefault', value: defaultInput.value };
    }
  }

  // graphql 16 and legacy definitions
  if (argDefinition.defaultValue !== undefined) {
    return { source: 'schemaDefault', value: argDefinition.defaultValue };
  }

  return { source: 'missing' };
};

/**
 * Finds the value of an argument in this order: literal value, request variable, variable default, schema default.
 * Never throws.
 */
export const findArgumentValue = (
  fieldNode: FieldNode,
  argDefinition: GraphQLArgument | undefined,
  argName: string,
  { variables, variableDefinitions }: ResolveArgumentOptions = {},
): ArgumentValue => {
  const argNode = fieldNode?.arguments?.find(arg => arg.name.value === argName);
  if (argNode) {
    if (argNode.value.kind !== Kind.VARIABLE) {
      return { source: 'literal', literal: argNode.value };
    }

    const variableName = argNode.value.name.value;
    if (hasVariable(variables, variableName)) {
      return { source: 'variable', value: variables[variableName] };
    }

    const variableDefault = variableDefinitions?.get(variableName)?.defaultValue;
    if (variableDefault) {
      return { source: 'variableDefault', literal: variableDefault };
    }

    // A variable that is not provided and has no default leaves the argument unset: the schema default applies
  }

  return getSchemaDefault(argDefinition);
};

/** Schema defaults are internal values: give enums back their name, as a client would send them */
const toExternalDefault = (argDefinition: GraphQLArgument, value: unknown): unknown => {
  const type = getNullableType(argDefinition.type);
  if (isEnumType(type)) {
    return type.getValues().find(enumValue => enumValue.value === value)?.name ?? value;
  }
  return value;
};

/**
 * The arguments of a field, as the cost functions of `extensions.cost` receive them: by name, for the arguments that
 * have a value or a default. See the top of this file for the shape of the values. Never throws: an argument that
 * cannot be read is left out.
 */
export const resolveFieldArguments = (
  fieldNode: FieldNode,
  fieldDefinition: GraphQLField<unknown, unknown>,
  options: ResolveArgumentOptions = {},
): Record<string, unknown> => {
  const args: Record<string, unknown> = {};
  for (const argDefinition of fieldDefinition.args) {
    try {
      const found = findArgumentValue(fieldNode, argDefinition, argDefinition.name, options);
      if (found.source === 'missing') {
        continue;
      } else if ('literal' in found) {
        // Variables nested in a literal (`account: { slug: $slug }`) are replaced by their value
        const variables = isPlainObject(options.variables) ? options.variables : undefined;
        args[argDefinition.name] = valueFromASTUntyped(found.literal, variables);
      } else if (found.source === 'schemaDefault') {
        args[argDefinition.name] = toExternalDefault(argDefinition, found.value);
      } else {
        args[argDefinition.name] = found.value;
      }
    } catch {
      // Leave it out
    }
  }

  return args;
};

// Parsers for cost functions. They accept anything, as the values are not validated.

/** Whether an argument is set to something other than `null` or an empty value (`""`, `[]`) */
export const isArgumentSet = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  !(typeof value === 'string' && value.trim() === '') &&
  !(Array.isArray(value) && value.length === 0);

/** A date argument (`DateTime`): an ISO string or a timestamp. `null` when it is not set or not a valid date. */
export const parseDateArgument = (value: unknown): Date | null => {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * The number of items of a list argument. GraphQL accepts a single value for a list (input coercion wraps it), so
 * anything else that is set counts as one item.
 */
export const getListArgumentLength = (value: unknown): number => {
  if (Array.isArray(value)) {
    return value.length;
  }
  return value === undefined || value === null ? 0 : 1;
};
