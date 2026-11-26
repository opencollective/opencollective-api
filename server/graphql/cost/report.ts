/**
 * Cost report of a set of GraphQL operations, such as all the operations of the frontend. Used by
 * `scripts/graphql-cost.ts` in CI, see opencollective/opencollective#9084.
 *
 * Each operation gets two costs:
 * - The cost: with the representative variables declared for the operation if any, otherwise without variables, so
 *   that each `limit` takes the default of its variable, then the default of the argument in the schema. This is
 *   the cost compared to the maximum.
 * - The cost with max limits, for information: every variable passed to a `limit` set to `DEFAULT_MAX_LIMIT`, the
 *   value the analyzer uses when it does not know the limit.
 */
import type { DocumentNode, FragmentDefinitionNode, GraphQLSchema, OperationDefinitionNode } from 'graphql';
import { GraphQLError, Kind, parse, print, visit } from 'graphql';

import { getQueryCost } from './index';
import { DEFAULT_MAX_LIMIT } from './limit';

/** Operations whose cost is above this share of the maximum are reported as close to it */
const DEFAULT_CLOSE_RATIO = 0.5;

/** Number of fields listed for each operation in the breakdown */
const TOP_FIELDS_COUNT = 3;

/** Number of operations listed in the top tables */
const TOP_OPERATIONS_COUNT = 10;

interface CostReportOperation {
  name: string;
  type: OperationDefinitionNode['operation'];
  /** File the operation was read from */
  source: string;
  /** The operation and the fragments it uses */
  document: DocumentNode;
}

interface OperationCost {
  name: string;
  type: OperationDefinitionNode['operation'];
  source: string;
  /** Cost compared to the maximum. `null` when the operation could not be analyzed (counts as over the maximum). */
  cost: number | null;
  /** Whether `cost` uses the representative variables declared for the operation */
  hasRepresentativeVariables: boolean;
  /** Cost with every `limit` variable at `DEFAULT_MAX_LIMIT`. Information only. */
  maxLimitCost: number | null;
  /** Variables passed to a `limit` argument */
  limitVariables: string[];
  /** Fields that contribute most to `cost` */
  topFields: { coordinate: string; cost: number }[];
  /** Why the operation could not be analyzed */
  error?: string;
}

export interface CostReport {
  max: number;
  closeThreshold: number;
  maxLimit: number;
  /** Most expensive first */
  operations: OperationCost[];
  /** Problems with the input: documents that cannot be parsed, missing fragments, unknown operations... */
  errors: string[];
}

/** Report of a previous run, as written by `--json`. Only the costs are read. */
interface BaselineReport {
  operations: { name: string; cost: number | null }[];
}

interface CostChange {
  name: string;
  source: string | null;
  before: number | null;
  after: number | null;
  status: 'added' | 'removed' | 'changed';
}

const getFragmentSpreads = (node: OperationDefinitionNode | FragmentDefinitionNode): string[] => {
  const names = new Set<string>();
  visit(node, {
    FragmentSpread(spread) {
      names.add(spread.name.value);
    },
  });
  return [...names];
};

/**
 * Reads the operations of a set of GraphQL documents. Fragments are shared between all the documents (as with
 * graphql-codegen), so an operation can use a fragment defined in another file. Every operation must have a
 * unique name, which is how representative variables and baselines refer to it.
 */
export const collectOperations = (
  files: { path: string; content: string }[],
): { operations: CostReportOperation[]; errors: string[] } => {
  const errors: string[] = [];
  const fragments = new Map<string, { definition: FragmentDefinitionNode; printed: string; path: string }>();
  const operations = new Map<string, { definition: OperationDefinitionNode; path: string }>();

  for (const file of files) {
    let document: DocumentNode;
    try {
      document = parse(file.content);
    } catch (error) {
      errors.push(`${file.path}: ${error instanceof GraphQLError ? error.message : error}`);
      continue;
    }

    for (const definition of document.definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        const name = definition.name.value;
        const printed = print(definition);
        const existing = fragments.get(name);
        if (existing && existing.printed !== printed) {
          errors.push(`${file.path}: fragment "${name}" is also defined differently in ${existing.path}`);
        } else if (!existing) {
          fragments.set(name, { definition, printed, path: file.path });
        }
      } else if (definition.kind === Kind.OPERATION_DEFINITION) {
        const name = definition.name?.value;
        if (!name) {
          errors.push(`${file.path}: operations must be named`);
        } else if (operations.has(name)) {
          errors.push(`${file.path}: operation "${name}" is also defined in ${operations.get(name).path}`);
        } else {
          operations.set(name, { definition, path: file.path });
        }
      }
    }
  }

  const result: CostReportOperation[] = [];
  for (const [name, { definition, path }] of operations) {
    const definitions: (OperationDefinitionNode | FragmentDefinitionNode)[] = [definition];
    const pending = getFragmentSpreads(definition);
    const included = new Set<string>();
    const missing = new Set<string>();
    while (pending.length) {
      const fragmentName = pending.pop();
      if (included.has(fragmentName) || missing.has(fragmentName)) {
        continue;
      }

      const fragment = fragments.get(fragmentName);
      if (!fragment) {
        missing.add(fragmentName);
      } else {
        included.add(fragmentName);
        definitions.push(fragment.definition);
        pending.push(...getFragmentSpreads(fragment.definition));
      }
    }

    if (missing.size) {
      errors.push(`${path}: operation "${name}" uses unknown fragments: ${[...missing].join(', ')}`);
    } else {
      result.push({
        name,
        type: definition.operation,
        source: path,
        document: { kind: Kind.DOCUMENT, definitions },
      });
    }
  }

  return { operations: result, errors };
};

/** Names of the variables passed to a `limit` argument, the only arguments the analyzer reads */
const getLimitVariables = (document: DocumentNode): string[] => {
  const names = new Set<string>();
  visit(document, {
    Argument(argument) {
      if (argument.name.value === 'limit' && argument.value.kind === Kind.VARIABLE) {
        names.add(argument.value.name.value);
      }
    },
  });
  return [...names].sort();
};

const toReportedCost = (cost: number): number | null => (Number.isFinite(cost) ? cost : null);

/**
 * Computes the cost of each operation against `schema`.
 *
 * @param representativeVariables Variables to use for the cost of some operations, by operation name, when the
 * defaults do not reflect how they are used.
 */
export const getCostReport = (
  schema: GraphQLSchema,
  operations: CostReportOperation[],
  {
    max,
    closeRatio = DEFAULT_CLOSE_RATIO,
    maxLimit = DEFAULT_MAX_LIMIT,
    representativeVariables = {},
    errors = [],
  }: {
    max: number;
    closeRatio?: number;
    maxLimit?: number;
    representativeVariables?: Record<string, Record<string, unknown>>;
    errors?: string[];
  },
): CostReport => {
  const reportErrors = [...errors];
  const operationNames = new Set(operations.map(operation => operation.name));
  for (const name of Object.keys(representativeVariables)) {
    if (!operationNames.has(name)) {
      reportErrors.push(`Representative variables are declared for an unknown operation: "${name}"`);
    }
  }

  const results = operations.map((operation): OperationCost => {
    const variables = representativeVariables[operation.name];
    const limitVariables = getLimitVariables(operation.document);
    const result = getQueryCost(schema, operation.document, {
      operationName: operation.name,
      variables: variables ?? {},
      maxLimit,
      breakdown: true,
    });
    const maxLimitResult = getQueryCost(schema, operation.document, {
      operationName: operation.name,
      variables: { ...variables, ...Object.fromEntries(limitVariables.map(name => [name, maxLimit])) },
      maxLimit,
    });

    return {
      name: operation.name,
      type: operation.type,
      source: operation.source,
      cost: toReportedCost(result.cost),
      hasRepresentativeVariables: Boolean(variables),
      maxLimitCost: toReportedCost(maxLimitResult.cost),
      limitVariables,
      topFields: (result.breakdown ?? []).slice(0, TOP_FIELDS_COUNT),
      error: result.error ?? (result.abortReason && `Too large to analyze (${result.abortReason})`),
    };
  });

  return {
    max,
    closeThreshold: max * closeRatio,
    maxLimit,
    operations: results.sort((a, b) => (b.cost ?? Infinity) - (a.cost ?? Infinity) || a.name.localeCompare(b.name)),
    errors: reportErrors,
  };
};

/** Operations that could not be analyzed count as over the maximum */
export const getOperationsOverMax = (report: CostReport): OperationCost[] =>
  report.operations.filter(operation => operation.cost === null || operation.cost > report.max);

const getOperationsCloseToMax = (report: CostReport): OperationCost[] =>
  report.operations.filter(
    operation => operation.cost !== null && operation.cost <= report.max && operation.cost > report.closeThreshold,
  );

/** Operations added, removed, or whose cost changed since `baseline` */
export const compareWithBaseline = (report: CostReport, baseline: BaselineReport): CostChange[] => {
  const before = new Map((baseline?.operations ?? []).map(operation => [operation.name, operation.cost ?? null]));
  const changes: CostChange[] = [];
  for (const operation of report.operations) {
    if (!before.has(operation.name)) {
      changes.push({
        name: operation.name,
        source: operation.source,
        before: null,
        after: operation.cost,
        status: 'added',
      });
    } else if (before.get(operation.name) !== operation.cost) {
      const previous = before.get(operation.name);
      changes.push({
        name: operation.name,
        source: operation.source,
        before: previous,
        after: operation.cost,
        status: 'changed',
      });
    }
    before.delete(operation.name);
  }
  for (const [name, cost] of before) {
    changes.push({ name, source: null, before: cost, after: null, status: 'removed' });
  }

  // Biggest increases first, removed operations last. A cost of `null` (not analyzable) counts as infinite.
  const delta = (change: CostChange) =>
    change.status === 'removed' ? -Infinity : (change.after ?? Infinity) - (change.before ?? 0);
  return changes.sort((a, b) => delta(b) - delta(a) || a.name.localeCompare(b.name));
};

const formatCost = (cost: number | null): string => (cost === null ? 'not analyzable' : cost.toLocaleString('en-US'));

const formatPercent = (part: number, whole: number): string =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%';

/** Escapes a value for a Markdown table cell, which also renders HTML */
const escapeCell = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, ' ');

const formatTopFields = (operation: OperationCost): string => {
  if (operation.error) {
    return escapeCell(operation.error);
  }

  return operation.topFields
    .map(field => `\`${field.coordinate}\` ${formatPercent(field.cost, operation.cost ?? 0)}`)
    .join('<br>');
};

const formatOperationsTable = (operations: OperationCost[], report: CostReport): string[] => [
  '| Operation | Cost | % of max | With max limits | Top fields |',
  '| --- | ---: | ---: | ---: | --- |',
  ...operations.map(
    operation =>
      `| \`${operation.name}\`${operation.hasRepresentativeVariables ? ' (representative variables)' : ''}<br><sub>${escapeCell(operation.source)}</sub> | ${formatCost(operation.cost)} | ${operation.cost === null ? '-' : formatPercent(operation.cost, report.max)} | ${formatCost(operation.maxLimitCost)} | ${formatTopFields(operation)} |`,
  ),
];

const formatChange = (change: CostChange): string => {
  if (change.status === 'added') {
    return 'new';
  } else if (change.status === 'removed') {
    return 'removed';
  } else if (change.before === null || change.after === null || change.before === 0) {
    return 'changed';
  } else {
    const percent = (change.after / change.before - 1) * 100;
    const sign = percent > 0 ? '+' : '-';
    return Math.abs(percent) < 1 ? `${sign}<1%` : `${sign}${Math.round(Math.abs(percent))}%`;
  }
};

/** Markdown report for a GitHub job summary */
export const formatCostReportMarkdown = (
  report: CostReport,
  {
    title = 'GraphQL query cost',
    baseline,
    notes = [],
  }: { title?: string; baseline?: BaselineReport; notes?: string[] } = {},
): string => {
  const overMax = getOperationsOverMax(report);
  const closeToMax = getOperationsCloseToMax(report);
  const lines = [
    `## ${title}`,
    '',
    `${report.operations.length} operations. Maximum: **${formatCost(report.max)}** (\`config.graphql.cost.max\`, the setting the API uses in production). ` +
      `Close to the maximum: above ${formatCost(report.closeThreshold)}.`,
    '',
    `The cost uses the representative variables declared for the operation if any, otherwise the defaults of the variables, then the defaults of the schema. ` +
      `"With max limits" sets every \`limit\` variable to ${formatCost(report.maxLimit)}, for information.`,
    ...notes.flatMap(note => ['', note]),
    '',
  ];

  if (report.errors.length) {
    lines.push(
      `### Problems with the input (${report.errors.length})`,
      '',
      ...report.errors.map(error => `- ${escapeCell(error)}`),
      '',
    );
  }

  lines.push(`### Over the maximum (${overMax.length})`, '');
  lines.push(...(overMax.length ? formatOperationsTable(overMax, report) : ['None.']), '');

  lines.push(`### Close to the maximum (${closeToMax.length})`, '');
  lines.push(...(closeToMax.length ? formatOperationsTable(closeToMax, report) : ['None.']), '');

  if (baseline) {
    const changes = compareWithBaseline(report, baseline);
    lines.push(`### Cost changes (${changes.length})`, '');
    if (changes.length) {
      lines.push(
        '| Operation | Before | After | Change |',
        '| --- | ---: | ---: | ---: |',
        ...changes.map(
          change =>
            `| \`${change.name}\`${change.source ? `<br><sub>${escapeCell(change.source)}</sub>` : ''} | ${change.status === 'added' ? '-' : formatCost(change.before)} | ${change.status === 'removed' ? '-' : formatCost(change.after)} | ${formatChange(change)} |`,
        ),
        '',
      );
    } else {
      lines.push('No operation changed cost.', '');
    }
  }

  const byMaxLimitCost = [...report.operations]
    .sort((a, b) => (b.maxLimitCost ?? Infinity) - (a.maxLimitCost ?? Infinity) || a.name.localeCompare(b.name))
    .slice(0, TOP_OPERATIONS_COUNT);
  lines.push(
    '<details>',
    `<summary>Top ${TOP_OPERATIONS_COUNT} operations by cost</summary>`,
    '',
    ...formatOperationsTable(report.operations.slice(0, TOP_OPERATIONS_COUNT), report),
    '',
    '</details>',
    '',
    '<details>',
    `<summary>Top ${TOP_OPERATIONS_COUNT} operations by cost with max limits (information only)</summary>`,
    '',
    ...formatOperationsTable(byMaxLimitCost, report),
    '',
    '</details>',
    '',
  );

  return lines.join('\n');
};
