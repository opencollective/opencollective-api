/**
 * Query cost analyzer.
 *
 * Computes the cost of a GraphQL operation from the schema, the document and the request variables:
 *
 *     cost(field) = weight + size × Σ cost(selected children)
 *
 * - `weight` is `DEFAULT_FIELD_WEIGHT`, or `PAGINATED_FIELD_WEIGHT` for fields that take a `limit`, unless the field
 *   declares `extensions.cost.weight` (one of the `CostTier` values).
 * - `size` is 1, except for lists under a field that takes a `limit`, where it is the requested limit. For a
 *   collection (`{ totalCount, limit, offset, nodes }`), the limit applies to `nodes` and not to the other fields.
 *   Fields that return a list without taking a `limit` declare their size in `extensions.cost.listSize`, which
 *   works the same way.
 *
 * This is a pure function with no dependency on Apollo or the database, so that the server, the tests and CI can
 * all call it. It never throws.
 */
import type {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  GraphQLCompositeType,
  GraphQLField,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLSchema,
  OperationDefinitionNode,
  SelectionSetNode,
  VariableDefinitionNode,
} from 'graphql';
import {
  getNamedType,
  getNullableType,
  isAbstractType,
  isCompositeType,
  isInterfaceType,
  isListType,
  isObjectType,
  Kind,
} from 'graphql';

import { CostTier, getFieldCostExtension, PARENT_LIMIT } from './extensions';
import { DEFAULT_MAX_LIMIT, resolveLimitArgument } from './limit';

/** Cost of a field that does not declare a weight */
export const DEFAULT_FIELD_WEIGHT = CostTier.Default;

/** Cost of a paginated field (one that takes a `limit`): at least one SQL query per parent item */
export const PAGINATED_FIELD_WEIGHT = CostTier.Query;

/** Maximum number of selections visited before giving up. Going over it counts as going over budget. */
export const DEFAULT_MAX_NODES = 20_000;

/**
 * Maximum nesting of selection sets (the operation's own selection set is at depth 1) before giving up. Going over it
 * counts as going over budget.
 */
export const DEFAULT_MAX_DEPTH = 100;

/** Fields that are never counted: introspection, and `__typename` which is resolved without any work */
const FREE_FIELDS = new Set(['__schema', '__type', '__typename']);

export interface QueryCostOptions {
  /** Request variables, as received. Only integer `limit` values are read from them. */
  variables?: unknown;
  /** Name of the operation to analyze. Required when the document contains several operations. */
  operationName?: string | null;
  /** Number of items to count when a `limit` is invalid or missing. Defaults to `DEFAULT_MAX_LIMIT`. */
  maxLimit?: number;
  /** See `DEFAULT_MAX_NODES` */
  maxNodes?: number;
  /** See `DEFAULT_MAX_DEPTH` */
  maxDepth?: number;
  /** Also compute `breakdown`, the fields that drive the cost. Off by default: used by the CI report. */
  breakdown?: boolean;
}

interface QueryCostField {
  /** Alias if any, otherwise field name */
  responseKey: string;
  fieldName: string;
  cost: number;
}

/** Cost of one schema field (`Type.field`) and its children, summed over all the places it is counted */
interface QueryCostBreakdownEntry {
  coordinate: string;
  cost: number;
}

interface QueryCostResult {
  /**
   * Total cost of the operation. `Infinity` when the analysis was aborted or failed unexpectedly. `0` with `error` set
   * when there is nothing to execute (no matching operation, unsupported root type): check `error` before reading
   * a zero cost as a successful estimate.
   */
  cost: number;
  operationName: string | null;
  operationType: OperationDefinitionNode['operation'] | null;
  /** Cost of each top-level field, in document order. Partial when the analysis was aborted. */
  fields: QueryCostField[];
  /** Number of selections visited by the analysis */
  visitedNodes: number;
  /**
   * With the `breakdown` option: the fields that drive the cost (the ones that take a `limit` or declare a weight or
   * a list size), with the cost of their whole selection multiplied by the number of times they are counted, most
   * expensive first. A field nested in another one counts in both, so the entries do not add up to `cost`.
   */
  breakdown?: QueryCostBreakdownEntry[];
  /** Set when the analysis stopped because the document is too expensive to analyze */
  abortReason?: 'MAX_NODES' | 'MAX_DEPTH';
  /** Set when the operation could not be analyzed: no matching operation or root type (cost 0), unexpected error (cost Infinity) */
  error?: string;
}

class AnalysisAbortedError extends Error {
  constructor(public readonly reason: QueryCostResult['abortReason']) {
    super(`Query cost analysis aborted: ${reason}`);
  }
}

/** Cost per schema coordinate (`Type.field`). Only built with the `breakdown` option. */
type Breakdown = Map<string, number>;

interface AnalysisContext {
  schema: GraphQLSchema;
  fragments: Map<string, FragmentDefinitionNode>;
  variables: unknown;
  variableDefinitions: Map<string, VariableDefinitionNode>;
  maxLimit: number;
  maxNodes: number;
  maxDepth: number;
  visitedNodes: number;
  /** Cost of a selection on a type, see `getSelectionCostCacheKey` */
  cache: Map<string, CachedSelectionCost>;
  /** Deepest selection set reached so far in the subtree being analyzed, used to check the depth of cached subtrees */
  deepestDepth: number;
  /** With the `breakdown` option, the breakdown of each cached selection, for one evaluation of it */
  breakdownCache: Map<string, Breakdown> | null;
  selectionSetIds: WeakMap<SelectionSetNode, number>;
  lastSelectionSetId: number;
}

interface CachedSelectionCost {
  cost: number;
  /** Number of nested selection set levels in the subtree, this one included */
  height: number;
}

/**
 * `size × cost`, except that `0 × Infinity` is NaN, which compares as under any budget. Fail closed: an infinite
 * subtree stays infinite.
 */
const multiplyCost = (size: number, cost: number): number => (size === 0 && cost === Infinity ? Infinity : size * cost);

/** Adds `source × factor` to `target`, when building a breakdown */
const addToBreakdown = (target: Breakdown | undefined, source: Breakdown | undefined, factor = 1): void => {
  if (target && source) {
    for (const [coordinate, cost] of source) {
      target.set(coordinate, (target.get(coordinate) ?? 0) + multiplyCost(factor, cost));
    }
  }
};

const addFieldToBreakdown = (
  breakdown: Breakdown,
  parentType: GraphQLCompositeType,
  fieldName: string,
  cost: number,
): void => {
  const coordinate = `${parentType.name}.${fieldName}`;
  breakdown.set(coordinate, (breakdown.get(coordinate) ?? 0) + cost);
};

/** Fields selected on a type, grouped by response key */
type CollectedFields = Map<string, FieldNode[]>;

const visitNode = (context: AnalysisContext): void => {
  context.visitedNodes++;
  if (context.visitedNodes > context.maxNodes) {
    throw new AnalysisAbortedError('MAX_NODES');
  }
};

/** Whether a fragment with this type condition applies when the runtime type is `type` */
const doesFragmentApply = (
  context: AnalysisContext,
  typeConditionName: string | undefined,
  type: GraphQLCompositeType,
): boolean => {
  if (!typeConditionName || typeConditionName === type.name) {
    return true;
  }

  const conditionType = context.schema.getType(typeConditionName);
  if (isAbstractType(conditionType) && (isObjectType(type) || isInterfaceType(type))) {
    return context.schema.isSubType(conditionType, type);
  }

  return false;
};

/**
 * Collects the fields selected on `type`, following fragments whose type condition applies, and groups them by
 * response key so that a field selected several times (directly and through fragments) counts once.
 * Like graphql-js, a fragment spread several times in the same selection is followed once.
 * `@skip` and `@include` are ignored on purpose: fields always count.
 */
const collectFields = (
  context: AnalysisContext,
  type: GraphQLCompositeType,
  selectionSets: readonly SelectionSetNode[],
): CollectedFields => {
  const fields: CollectedFields = new Map();
  const visitedFragments = new Set<string>();

  const collect = (selectionSet: SelectionSetNode) => {
    for (const selection of selectionSet?.selections ?? []) {
      visitNode(context);
      if (selection.kind === Kind.FIELD) {
        const responseKey = selection.alias?.value ?? selection.name.value;
        const existing = fields.get(responseKey);
        if (existing) {
          existing.push(selection);
        } else {
          fields.set(responseKey, [selection]);
        }
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        if (doesFragmentApply(context, selection.typeCondition?.name.value, type)) {
          collect(selection.selectionSet);
        }
      } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const fragmentName = selection.name.value;
        const fragment = context.fragments.get(fragmentName);
        if (fragment && !visitedFragments.has(fragmentName)) {
          visitedFragments.add(fragmentName);
          if (doesFragmentApply(context, fragment.typeCondition.name.value, type)) {
            collect(fragment.selectionSet);
          }
        }
      }
    }
  };

  selectionSets.forEach(collect);
  return fields;
};

/**
 * Whether a selection on an abstract type uses fragments on other types (`... on Collective`). If it does not,
 * the selection can be analyzed once against the abstract type itself rather than once per possible type.
 */
const hasTypeConditions = (
  context: AnalysisContext,
  type: GraphQLNamedType,
  selectionSets: readonly SelectionSetNode[],
): boolean => {
  const visitedFragments = new Set<string>();
  const check = (selectionSet: SelectionSetNode): boolean => {
    for (const selection of selectionSet?.selections ?? []) {
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        const typeConditionName = selection.typeCondition?.name.value;
        if ((typeConditionName && typeConditionName !== type.name) || check(selection.selectionSet)) {
          return true;
        }
      } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const fragment = context.fragments.get(selection.name.value);
        if (fragment && !visitedFragments.has(fragment.name.value)) {
          visitedFragments.add(fragment.name.value);
          if (fragment.typeCondition.name.value !== type.name || check(fragment.selectionSet)) {
            return true;
          }
        }
      }
    }

    return false;
  };

  return selectionSets.some(check);
};

const getSelectionSetId = (context: AnalysisContext, selectionSet: SelectionSetNode): number => {
  let id = context.selectionSetIds.get(selectionSet);
  if (id === undefined) {
    id = ++context.lastSelectionSetId;
    context.selectionSetIds.set(selectionSet, id);
  }
  return id;
};

/**
 * The cost of a selection only depends on the type, the selection sets and the pending list size, so it can be
 * cached. This keeps fragments that are spread in many places (or nested abstract types) linear to analyze.
 * The depth is not part of the key: the height of the subtree is cached with its cost and checked on reuse.
 */
const getSelectionCostCacheKey = (
  context: AnalysisContext,
  type: GraphQLNamedType,
  selectionSets: readonly SelectionSetNode[],
  pendingListSize: number | undefined,
): string => {
  const ids = selectionSets.map(selectionSet => getSelectionSetId(context, selectionSet));
  return `${type.name}|${pendingListSize ?? ''}|${ids.join(',')}`;
};

/**
 * Cost of the selection sets of a field returning `type`.
 *
 * `pendingListSize` is the limit (or the declared `listSize`) of a field that returns a single object (a collection).
 * It is applied to the first list found below it (`nodes`), passing through fields that return a single object
 * without arguments (as in `search { results { accounts(limit: 10) { collection { nodes } } } }`), unless that list
 * declares its own `listSize`.
 */
const getSelectionCost = (
  context: AnalysisContext,
  type: GraphQLNamedType,
  selectionSets: readonly SelectionSetNode[],
  pendingListSize: number | undefined,
  depth: number,
  breakdown?: Breakdown,
): number => {
  if (!isCompositeType(type) || selectionSets.length === 0) {
    return 0;
  } else if (depth > context.maxDepth) {
    throw new AnalysisAbortedError('MAX_DEPTH');
  }

  const cacheKey = getSelectionCostCacheKey(context, type, selectionSets, pendingListSize);
  const cached = context.cache.get(cacheKey);
  if (cached !== undefined) {
    const deepestDepth = depth + cached.height - 1;
    if (deepestDepth > context.maxDepth) {
      throw new AnalysisAbortedError('MAX_DEPTH');
    }
    context.deepestDepth = Math.max(context.deepestDepth, deepestDepth);
    addToBreakdown(breakdown, context.breakdownCache?.get(cacheKey));
    return cached.cost;
  }

  const outerDeepestDepth = context.deepestDepth;
  context.deepestDepth = depth;

  let cost: number;
  let selectionBreakdown: Breakdown | undefined;
  if (isAbstractType(type) && hasTypeConditions(context, type, selectionSets)) {
    // Interfaces and unions count as their most expensive possible type
    cost = 0;
    for (const possibleType of context.schema.getPossibleTypes(type)) {
      const fields = collectFields(context, possibleType, selectionSets);
      const typeBreakdown: Breakdown | undefined = breakdown ? new Map() : undefined;
      const typeCost = getFieldsCost(context, possibleType, fields, pendingListSize, depth, typeBreakdown);
      if (typeCost > cost || !selectionBreakdown) {
        selectionBreakdown = typeBreakdown;
      }
      cost = Math.max(cost, typeCost);
    }
  } else {
    const fields = collectFields(context, type, selectionSets);
    selectionBreakdown = breakdown ? new Map() : undefined;
    cost = getFieldsCost(context, type, fields, pendingListSize, depth, selectionBreakdown);
  }

  context.cache.set(cacheKey, { cost, height: context.deepestDepth - depth + 1 });
  context.deepestDepth = Math.max(outerDeepestDepth, context.deepestDepth);
  if (breakdown) {
    context.breakdownCache.set(cacheKey, selectionBreakdown ?? new Map());
    addToBreakdown(breakdown, selectionBreakdown);
  }

  return cost;
};

const getFieldsCost = (
  context: AnalysisContext,
  parentType: GraphQLCompositeType,
  fields: CollectedFields,
  pendingListSize: number | undefined,
  depth: number,
  breakdown?: Breakdown,
): number => {
  let cost = 0;
  for (const fieldNodes of fields.values()) {
    cost += getFieldCost(context, parentType, fieldNodes, pendingListSize, depth, breakdown);
  }
  return cost;
};

const getFieldDefinition = (
  parentType: GraphQLCompositeType,
  fieldName: string,
): GraphQLField<unknown, unknown> | undefined => {
  return 'getFields' in parentType ? parentType.getFields()[fieldName] : undefined;
};

/** Cost of a field, given all the nodes that select it under the same response key */
const getFieldCost = (
  context: AnalysisContext,
  parentType: GraphQLCompositeType,
  fieldNodes: readonly FieldNode[],
  pendingListSize: number | undefined,
  depth: number,
  breakdown?: Breakdown,
): number => {
  const fieldName = fieldNodes[0].name.value;
  if (FREE_FIELDS.has(fieldName)) {
    return 0;
  }

  // Unknown fields are rejected by validation, they do not need to be counted
  const fieldDefinition = getFieldDefinition(parentType, fieldName);
  if (!fieldDefinition) {
    return 0;
  }

  const limitArgument = fieldDefinition.args.find(arg => arg.name === 'limit');
  const costExtension = getFieldCostExtension(fieldDefinition);
  const weight = costExtension.weight ?? (limitArgument ? PAGINATED_FIELD_WEIGHT : DEFAULT_FIELD_WEIGHT);
  const returnType = getNamedType(fieldDefinition.type);
  // Fields that drive the cost: the ones that take a limit or declare a weight or a list size
  const isInBreakdown = Boolean(
    breakdown && (limitArgument || costExtension.weight !== undefined || costExtension.listSize !== undefined),
  );
  if (!isCompositeType(returnType)) {
    if (isInBreakdown) {
      addFieldToBreakdown(breakdown, parentType, fieldName, weight);
    }
    return weight;
  }

  const isList = isListType(getNullableType(fieldDefinition.type));
  let size = 1;
  let childrenPendingListSize: number | undefined;
  if (limitArgument) {
    // Fields under the same response key have the same arguments (enforced by validation), use the first one
    const { value: limit } = resolveLimitArgument(fieldNodes[0], limitArgument, context);
    if (isList) {
      size = limit;
    } else {
      childrenPendingListSize = limit;
    }
  } else if (costExtension.listSize !== undefined && costExtension.listSize !== PARENT_LIMIT) {
    // A declared size replaces the limit of an enclosing paginated field, which stops here
    if (isList) {
      size = costExtension.listSize;
    } else {
      childrenPendingListSize = costExtension.listSize;
    }
  } else if (pendingListSize !== undefined) {
    if (isList) {
      size = pendingListSize;
    } else if (fieldDefinition.args.length === 0) {
      childrenPendingListSize = pendingListSize;
    }
  }

  const selectionSets = fieldNodes.map(node => node.selectionSet).filter(Boolean);
  const childrenBreakdown: Breakdown | undefined = breakdown ? new Map() : undefined;
  const childrenCost = getSelectionCost(
    context,
    returnType,
    selectionSets,
    childrenPendingListSize,
    depth + 1,
    childrenBreakdown,
  );
  const cost = weight + multiplyCost(size, childrenCost);
  if (breakdown) {
    addToBreakdown(breakdown, childrenBreakdown, size);
    if (isInBreakdown) {
      addFieldToBreakdown(breakdown, parentType, fieldName, cost);
    }
  }
  return cost;
};

const getOperation = (document: DocumentNode, operationName: string | null | undefined) => {
  const operations = (document?.definitions ?? []).filter(
    (definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION,
  );

  if (operationName) {
    return operations.find(operation => operation.name?.value === operationName);
  } else if (operations.length === 1) {
    return operations[0];
  }
};

const getRootType = (schema: GraphQLSchema, operation: OperationDefinitionNode): GraphQLObjectType | undefined => {
  if (operation.operation === 'query') {
    return schema.getQueryType() ?? undefined;
  } else if (operation.operation === 'mutation') {
    return schema.getMutationType() ?? undefined;
  } else if (operation.operation === 'subscription') {
    return schema.getSubscriptionType() ?? undefined;
  }
};

/**
 * Computes the cost of an operation, with a breakdown per top-level field. Never throws: problems are reported
 * through `error` and `abortReason`.
 */
export const getQueryCost = (
  schema: GraphQLSchema,
  document: DocumentNode,
  options: QueryCostOptions | null = {},
): QueryCostResult => {
  const result: QueryCostResult = {
    cost: 0,
    operationName: null,
    operationType: null,
    fields: [],
    visitedNodes: 0,
  };

  let context: AnalysisContext;
  try {
    const {
      variables,
      operationName,
      maxLimit = DEFAULT_MAX_LIMIT,
      maxNodes = DEFAULT_MAX_NODES,
      maxDepth = DEFAULT_MAX_DEPTH,
      breakdown = false,
    } = options ?? {};
    result.operationName = operationName ?? null;
    const operation = getOperation(document, operationName);
    if (!operation) {
      // Execution fails the same way, nothing runs
      result.error = operationName ? `Unknown operation "${operationName}"` : 'Could not determine the operation';
      return result;
    }

    result.operationName = operation.name?.value ?? null;
    result.operationType = operation.operation;
    const rootType = getRootType(schema, operation);
    if (!rootType) {
      result.error = `The schema does not support ${operation.operation} operations`;
      return result;
    }

    context = {
      schema,
      fragments: new Map(
        document.definitions
          .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
          .map(fragment => [fragment.name.value, fragment]),
      ),
      variables,
      variableDefinitions: new Map(
        (operation.variableDefinitions ?? []).map(definition => [definition.variable.name.value, definition]),
      ),
      maxLimit: Number.isInteger(maxLimit) && maxLimit >= 0 ? maxLimit : DEFAULT_MAX_LIMIT,
      maxNodes,
      maxDepth,
      visitedNodes: 0,
      cache: new Map(),
      deepestDepth: 0,
      breakdownCache: breakdown ? new Map() : null,
      selectionSetIds: new WeakMap(),
      lastSelectionSetId: 0,
    };

    if (context.maxDepth < 1) {
      throw new AnalysisAbortedError('MAX_DEPTH'); // The operation's own selection set is at depth 1
    }

    const fields = collectFields(context, rootType, [operation.selectionSet]);
    const operationBreakdown: Breakdown | undefined = breakdown ? new Map() : undefined;
    for (const [responseKey, fieldNodes] of fields) {
      const cost = getFieldCost(context, rootType, fieldNodes, undefined, 1, operationBreakdown);
      result.fields.push({ responseKey, fieldName: fieldNodes[0].name.value, cost });
      result.cost += cost;
    }

    if (Number.isNaN(result.cost)) {
      result.cost = Infinity; // Defensive: NaN would compare as under any budget
    }

    if (operationBreakdown) {
      result.breakdown = [...operationBreakdown]
        .map(([coordinate, cost]) => ({ coordinate, cost }))
        .sort((a, b) => b.cost - a.cost || a.coordinate.localeCompare(b.coordinate));
    }
  } catch (error) {
    // Fail closed: an operation that cannot be analyzed counts as over budget
    result.cost = Infinity;
    if (error instanceof AnalysisAbortedError) {
      result.abortReason = error.reason;
    } else {
      result.error = `Query cost analysis failed: ${error?.message ?? error}`;
    }
  }

  result.visitedNodes = context?.visitedNodes ?? 0;
  return result;
};
