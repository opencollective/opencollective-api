/**
 * Structural limits for GraphQL operations: depth, tokens, aliases and directives.
 *
 * They replace the matching GraphQL Armor protections, with the same limits and the same counting rules,
 * so that the switch does not change what gets rejected. See opencollective/opencollective#9085.
 */

import type {
  DocumentNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  SelectionSetNode,
  ValidationContext,
  ValidationRule,
} from 'graphql';
import { GraphQLError, Kind, Lexer, Source, TokenKind } from 'graphql';

const STRUCTURAL_LIMITS = {
  /** Number of nested selections. Currently identified max: 13 in the contribution flow. */
  maxDepth: 20,
  /** Number of lexical tokens in the query document. Currently identified max: the ExpensePage query. */
  maxTokens: 1500,
  /** Number of aliased fields, `__typename` excluded. */
  maxAliases: 100,
  /** Number of directives. */
  maxDirectives: 100,
} as const;

type StructuralLimitName = keyof typeof STRUCTURAL_LIMITS;

export type StructuralLimitViolation = {
  limit: StructuralLimitName;
  max: number;
  /** The value found. For tokens, counting stops at `max + 1`. */
  found: number;
  message: string;
};

type StructuralMetrics = {
  depth: number;
  aliases: number;
  directives: number;
};

/** Selections named `__typename` (or aliased to it) are not counted as aliases. */
const ALIASES_ALLOW_LIST = ['__typename'];

/** The introspection entry point, ignored when computing depth. */
const INTROSPECTION_FIELD = '__schema';

/**
 * Counts the lexical tokens of a query (comments and the end-of-file marker excluded), stopping as soon as
 * `limit` is exceeded so that oversized documents are never lexed to the end.
 *
 * Returns `limit + 1` when the limit is exceeded. A document that cannot be lexed returns the count reached
 * so far: the parser reports the syntax error.
 */
export const countTokens = (query: string, limit: number = STRUCTURAL_LIMITS.maxTokens): number => {
  const lexer = new Lexer(new Source(query));
  let count = 0;
  try {
    while (count <= limit && lexer.advance().kind !== TokenKind.EOF) {
      count++;
    }
  } catch {
    // Syntax error, reported by the parser
  }
  return count;
};

type FragmentMetrics = StructuralMetrics | 'in-progress';

/**
 * Computes depth, aliases and directives of an operation in a single walk that follows fragment spreads.
 *
 * Counting rules match GraphQL Armor's (`flattenFragments: false`, `ignoreIntrospection: true`):
 * - Depth: every selection (field, inline fragment or fragment spread) adds a level, and a fragment spread adds
 *   another one before the fragment's own selections. Selections under `__schema` are not counted.
 * - Aliases and directives: a fragment's counts are added every time it is spread.
 * - Each fragment is walked once per document: later spreads reuse its counts, so the walk stays linear in the
 *   document size even when fragments are spread many times. Fragment cycles (rejected by the standard
 *   validation rules) count as zero.
 */
class StructuralMetricsWalker {
  private readonly fragmentMetrics = new Map<string, FragmentMetrics>();
  private readonly getFragment: (name: string) => FragmentDefinitionNode | null | undefined;

  constructor(getFragment: (name: string) => FragmentDefinitionNode | null | undefined) {
    this.getFragment = getFragment;
  }

  walkOperation(operation: OperationDefinitionNode): StructuralMetrics {
    const children = this.walkSelectionSet(operation.selectionSet, 0);
    return { ...children, directives: children.directives + (operation.directives?.length ?? 0) };
  }

  private walkFragment(fragment: FragmentDefinitionNode): StructuralMetrics {
    const children = this.walkSelectionSet(fragment.selectionSet, 0);
    return { ...children, directives: children.directives + (fragment.directives?.length ?? 0) };
  }

  /**
   * @param parentDepth the depth of the node owning the selection set
   * @returns the deepest depth reached (at least `parentDepth`) and the counts of the selections
   */
  private walkSelectionSet(selectionSet: SelectionSetNode | undefined, parentDepth: number): StructuralMetrics {
    const result = { depth: parentDepth, aliases: 0, directives: 0 };
    for (const selection of selectionSet?.selections ?? []) {
      const depth = parentDepth + 1;
      result.directives += selection.directives?.length ?? 0;
      if (selection.kind === Kind.FIELD) {
        if (
          selection.alias &&
          !ALIASES_ALLOW_LIST.includes(selection.alias.value) &&
          !ALIASES_ALLOW_LIST.includes(selection.name.value)
        ) {
          result.aliases++;
        }

        const children = this.walkSelectionSet(selection.selectionSet, depth);
        result.aliases += children.aliases;
        result.directives += children.directives;
        if (selection.name.value !== INTROSPECTION_FIELD) {
          result.depth = Math.max(result.depth, children.depth);
        }
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        const children = this.walkSelectionSet(selection.selectionSet, depth);
        result.aliases += children.aliases;
        result.directives += children.directives;
        result.depth = Math.max(result.depth, children.depth);
      } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const fragment = this.getFragmentMetrics(selection.name.value);
        if (fragment) {
          result.aliases += fragment.aliases;
          result.directives += fragment.directives;
          result.depth = Math.max(result.depth, depth + 1 + fragment.depth);
        } else {
          result.depth = Math.max(result.depth, depth);
        }
      }
    }

    return result;
  }

  private getFragmentMetrics(name: string): StructuralMetrics | null {
    const cached = this.fragmentMetrics.get(name);
    if (cached === 'in-progress') {
      return { depth: 0, aliases: 0, directives: 0 }; // Fragment cycle
    } else if (cached) {
      return cached;
    }

    const fragment = this.getFragment(name);
    if (!fragment) {
      return null;
    }

    this.fragmentMetrics.set(name, 'in-progress');
    const metrics = this.walkFragment(fragment);
    this.fragmentMetrics.set(name, metrics);
    return metrics;
  }
}

/**
 * Computes the structural metrics of every operation in the document and returns the highest value of each.
 */
export const computeStructuralMetrics = (
  document: DocumentNode,
  getFragment?: (name: string) => FragmentDefinitionNode | null | undefined,
): StructuralMetrics => {
  if (!getFragment) {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const definition of document.definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.set(definition.name.value, definition);
      }
    }
    getFragment = name => fragments.get(name);
  }

  const walker = new StructuralMetricsWalker(getFragment);
  const result = { depth: 0, aliases: 0, directives: 0 };
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      const metrics = walker.walkOperation(definition);
      result.depth = Math.max(result.depth, metrics.depth);
      result.aliases = Math.max(result.aliases, metrics.aliases);
      result.directives = Math.max(result.directives, metrics.directives);
    }
  }

  return result;
};

export const getTokenLimitViolation = (tokens: number): StructuralLimitViolation | null => {
  const max = STRUCTURAL_LIMITS.maxTokens;
  return tokens > max ? { limit: 'maxTokens', max, found: tokens, message: `Token limit of ${max} exceeded.` } : null;
};

export const getStructuralLimitViolations = (metrics: StructuralMetrics): StructuralLimitViolation[] => {
  const violations: StructuralLimitViolation[] = [];
  const { maxDepth, maxAliases, maxDirectives } = STRUCTURAL_LIMITS;
  if (metrics.depth > maxDepth) {
    const message = `Query depth limit of ${maxDepth} exceeded, found ${metrics.depth}.`;
    violations.push({ limit: 'maxDepth', max: maxDepth, found: metrics.depth, message });
  }
  if (metrics.aliases > maxAliases) {
    const message = `Aliases limit of ${maxAliases} exceeded, found ${metrics.aliases}.`;
    violations.push({ limit: 'maxAliases', max: maxAliases, found: metrics.aliases, message });
  }
  if (metrics.directives > maxDirectives) {
    const message = `Directives limit of ${maxDirectives} exceeded, found ${metrics.directives}.`;
    violations.push({ limit: 'maxDirectives', max: maxDirectives, found: metrics.directives, message });
  }
  return violations;
};

/**
 * Metrics computed by the validation rule, by document. The Apollo plugin reads them to report violations,
 * including for documents served from Apollo's document cache, which skips validation.
 */
const metricsByDocument = new WeakMap<DocumentNode, StructuralMetrics>();

export const getComputedStructuralMetrics = (document: DocumentNode | undefined): StructuralMetrics | undefined => {
  return document ? metricsByDocument.get(document) : undefined;
};

/**
 * A validation rule that computes the depth, aliases and directives of the document. With `shouldReject`
 * returning true, it reports one validation error per exceeded limit, which Apollo returns as an HTTP 400 with
 * the `GRAPHQL_VALIDATION_FAILED` code.
 */
export const createStructuralLimitsValidationRule = (shouldReject: () => boolean): ValidationRule => {
  return (context: ValidationContext) => ({
    Document: {
      leave(document: DocumentNode) {
        const metrics = computeStructuralMetrics(document, name => context.getFragment(name));
        metricsByDocument.set(document, metrics);
        if (shouldReject()) {
          for (const violation of getStructuralLimitViolations(metrics)) {
            context.reportError(new GraphQLError(violation.message, { extensions: { limit: violation.limit } }));
          }
        }
      },
    },
  });
};
