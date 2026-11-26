import fs from 'fs';
import path from 'path';

import type { BaseContext, GraphQLRequestContextParsingDidStart, GraphQLRequestListener } from '@apollo/server';
import { ApolloArmor } from '@escape.tech/graphql-armor';
import { expect } from 'chai';
import type { DocumentNode } from 'graphql';
import { parse, specifiedRules, validate } from 'graphql';

import {
  computeStructuralMetrics,
  countTokens,
  createStructuralLimitsValidationRule,
  getComputedStructuralMetrics,
  getStructuralLimitViolations,
  getTokenLimitViolation,
} from '../../../../server/graphql/protection/structural-limits';
import graphqlSchemaV2 from '../../../../server/graphql/v2/schema';

type Counts = { depth: number; aliases: number; directives: number; tokens: number };

/**
 * Operations from the frontend (`lib/graphql/types/v2/graphql.ts`), picked for having the highest depth, aliases,
 * directives or tokens. `expected` holds the counts of GraphQL Armor 3.2.0, to keep once Armor is removed.
 */
const FRONTEND_OPERATIONS: { name: string; query: string; expected: Counts }[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/frontend-operations.json'), 'utf8'),
);

/**
 * Synthetic queries exercising fragments, introspection and directives. They don't need to be valid against the
 * schema: Armor and our implementation only look at the document.
 */
const SYNTHETIC_QUERIES: Record<string, string> = {
  flat: '{ a b c }',
  nested: '{ a { b { c { d } } } }',
  namedFragment: '{ a { ...F } } fragment F on A { b { c } }',
  nestedFragments:
    '{ a { ...F1 } } fragment F1 on A { b { ...F2 } } fragment F2 on B { c { ...F3 } } fragment F3 on C { d }',
  sameFragmentSpreadSeveralTimes:
    '{ a { ...F } b { ...F } c { d { ...F } } } fragment F on A { x: id y: name @include(if: true) z { w } }',
  fragmentSpreadInsideFragmentSeveralTimes:
    '{ a { ...F1 ...F1 } } fragment F1 on A { ...F2 ...F2 x: id } fragment F2 on A { y: id @skip(if: false) }',
  inlineFragments: '{ a { ... on A { b { ... on B { c } } } ... @include(if: true) { d } } }',
  aliases: '{ x: a { y: b __typename t: __typename } z: c }',
  introspection: '{ __schema { types { fields { type { ofType { ofType { ofType { name } } } } } } } }',
  introspectionWithFragment: '{ a { b } __schema { ...T } } fragment T on __Schema { types { x: name } }',
  directives: 'query Q @a @b { a @c { b @d @e } }',
  multipleOperations: 'query A { a { b { c } } } query B { x: a y: b z: c }',
  comments: '# a comment\n{ a # another one\n b }',
  variablesAndArguments:
    'query Q($a: Int = 1, $b: [String!]) { a(x: $a, y: { z: [1, 2, $b] }) { b(s: "str", t: """block""") } }',
};

const getArmorCounts = async (query: string): Promise<Counts> => {
  // Armor checks each operation of the document separately, we keep the highest value like our implementation
  const counts: Partial<Counts> = {};
  const capture = (key: keyof Counts) => [(_, { n }) => (counts[key] = Math.max(counts[key] ?? 0, n))];
  const options = { n: Number.MAX_SAFE_INTEGER, propagateOnRejection: false };
  const { plugins, validationRules } = new ApolloArmor({
    maxDepth: { ...options, onAccept: capture('depth') },
    maxAliases: { ...options, onAccept: capture('aliases') },
    maxDirectives: { ...options, onAccept: capture('directives') },
    maxTokens: { ...options, onAccept: capture('tokens') },
    costLimit: { enabled: false },
    blockFieldSuggestion: { enabled: false },
  }).protect();

  validate(graphqlSchemaV2, parse(query), validationRules);
  counts.tokens = 0;
  for (const plugin of plugins) {
    // Armor's token limit is a plugin that parses the source in `parsingDidStart`
    const listener = (await plugin.requestDidStart?.(null)) as GraphQLRequestListener<BaseContext> | undefined;
    await listener?.parsingDidStart?.({ source: query } as GraphQLRequestContextParsingDidStart<BaseContext>);
  }

  return counts as Counts;
};

const getOurCounts = (query: string): Counts => ({
  ...computeStructuralMetrics(parse(query)),
  tokens: countTokens(query, Number.MAX_SAFE_INTEGER),
});

describe('server/graphql/protection/structural-limits', () => {
  describe('matches GraphQL Armor', () => {
    for (const { name, query, expected } of FRONTEND_OPERATIONS) {
      it(`frontend operation ${name}`, async () => {
        const counts = getOurCounts(query);
        expect(counts).to.deep.equal(await getArmorCounts(query));
        expect(counts).to.deep.equal(expected);
      });
    }

    for (const [name, query] of Object.entries(SYNTHETIC_QUERIES)) {
      it(`synthetic query ${name}`, async () => {
        expect(getOurCounts(query)).to.deep.equal(await getArmorCounts(query));
      });
    }
  });

  describe('countTokens', () => {
    it('counts lexical tokens, ignoring comments', () => {
      expect(countTokens('{ a }')).to.equal(3);
      expect(countTokens('# comment\n{ a(x: "str") }')).to.equal(8);
      expect(countTokens('')).to.equal(0);
    });

    it('stops counting once the limit is exceeded', () => {
      const query = `{ ${Array(10_000).fill('a').join(' ')} }`;
      expect(countTokens(query, 1500)).to.equal(1501);
      expect(countTokens(query, 10)).to.equal(11);
    });

    it('returns the count reached on syntax errors', () => {
      expect(countTokens('{ a "unterminated')).to.equal(2);
    });
  });

  describe('computeStructuralMetrics', () => {
    it('counts a field nested in a fragment spread like Armor (a spread adds two levels)', () => {
      expect(computeStructuralMetrics(parse('{ a { b } }')).depth).to.equal(2);
      expect(computeStructuralMetrics(parse('{ a { ... on A { b } } }')).depth).to.equal(3);
      expect(computeStructuralMetrics(parse('{ a { ...F } } fragment F on A { b }')).depth).to.equal(4);
    });

    it('follows nested fragments', () => {
      const metrics = computeStructuralMetrics(parse(SYNTHETIC_QUERIES.nestedFragments));
      expect(metrics).to.deep.equal({ depth: 10, aliases: 0, directives: 0 });
    });

    it('counts aliases and directives of a fragment every time it is spread', () => {
      const metrics = computeStructuralMetrics(parse(SYNTHETIC_QUERIES.sameFragmentSpreadSeveralTimes));
      expect(metrics).to.deep.equal({ depth: 6, aliases: 6, directives: 3 });

      const nested = computeStructuralMetrics(parse(SYNTHETIC_QUERIES.fragmentSpreadInsideFragmentSeveralTimes));
      expect(nested.aliases).to.equal(2 * (1 + 2 * 1));
      expect(nested.directives).to.equal(2 * 2 * 1);
    });

    it('stays linear when fragments are spread many times', () => {
      // 30 levels of fragments, each spreading the next one twice: 2^30 expanded selections
      const fragments = Array.from(
        { length: 30 },
        (_, i) => `fragment F${i} on A { x${i}: id ...F${i + 1} ...F${i + 1} }`,
      );
      const query = `{ a { ...F0 } } ${fragments.join(' ')} fragment F30 on A { id }`;
      const start = Date.now();
      const metrics = computeStructuralMetrics(parse(query));
      expect(Date.now() - start).to.be.lessThan(100);
      expect(metrics.aliases).to.equal(2 ** 30 - 1);
      expect(metrics.depth).to.equal(2 + 30 * 2 + 1 + 1);
    });

    it('ignores introspection for depth, but not for aliases', () => {
      expect(computeStructuralMetrics(parse(SYNTHETIC_QUERIES.introspection)).depth).to.equal(0);
      expect(computeStructuralMetrics(parse(SYNTHETIC_QUERIES.introspectionWithFragment))).to.deep.equal({
        depth: 2,
        aliases: 1,
        directives: 0,
      });
    });

    it('does not count __typename aliases', () => {
      expect(computeStructuralMetrics(parse(SYNTHETIC_QUERIES.aliases)).aliases).to.equal(3);
    });

    it('returns the highest value of each metric across operations', () => {
      const metrics = computeStructuralMetrics(parse(SYNTHETIC_QUERIES.multipleOperations));
      expect(metrics).to.deep.equal({ depth: 3, aliases: 3, directives: 0 });
    });

    it('terminates on fragment cycles', () => {
      const metrics = computeStructuralMetrics(
        parse('{ a { ...F1 } } fragment F1 on A { ...F2 } fragment F2 on A { ...F1 }'),
      );
      expect(metrics.depth).to.be.a('number');
    });

    it('counts the directives of every spread of a fragment, unlike Armor', async () => {
      // Armor skips the directives of a spread when the fragment was already visited
      const query = '{ a { ...F @include(if: true) } b { ...F @include(if: true) } } fragment F on A { id }';
      expect(computeStructuralMetrics(parse(query)).directives).to.equal(2);
      expect((await getArmorCounts(query)).directives).to.equal(1);
    });
  });

  describe('violations', () => {
    it('reports nothing within the limits', () => {
      expect(getStructuralLimitViolations({ depth: 20, aliases: 100, directives: 100 })).to.deep.equal([]);
      expect(getTokenLimitViolation(1500)).to.be.null;
    });

    it('states the limit and the value found', () => {
      const violations = getStructuralLimitViolations({ depth: 21, aliases: 101, directives: 150 });
      expect(violations.map(v => v.message)).to.deep.equal([
        'Query depth limit of 20 exceeded, found 21.',
        'Aliases limit of 100 exceeded, found 101.',
        'Directives limit of 100 exceeded, found 150.',
      ]);
      expect(getTokenLimitViolation(1501).message).to.equal('Token limit of 1500 exceeded, found more than 1500.');
    });
  });

  describe('createStructuralLimitsValidationRule', () => {
    const deepQuery = `{ account(slug: "x") { ${'parent { '.repeat(25)} id ${'} '.repeat(25)} } }`;

    it('only records the metrics in log-only mode', () => {
      const document: DocumentNode = parse(deepQuery);
      const errors = validate(graphqlSchemaV2, document, [createStructuralLimitsValidationRule(() => false)]);
      expect(errors).to.have.length(0);
      expect(getComputedStructuralMetrics(document).depth).to.equal(27);
    });

    it('records the metrics even when the standard rules abort the validation', () => {
      const fields = Array.from({ length: 150 }, (_, i) => `x${i}: unknownField`).join(' ');
      const document: DocumentNode = parse(`{ account(slug: "x") { ${fields} } }`);
      const rule = createStructuralLimitsValidationRule(() => false);
      const errors = validate(graphqlSchemaV2, document, [...specifiedRules, rule]);
      expect(errors.at(-1).message).to.equal('Too many validation errors, error limit reached. Validation aborted.');
      expect(getComputedStructuralMetrics(document).aliases).to.equal(150);
    });

    it('reports an error per exceeded limit in rejection mode', () => {
      const errors = validate(graphqlSchemaV2, parse(deepQuery), [createStructuralLimitsValidationRule(() => true)]);
      expect(errors.map(e => e.message)).to.deep.equal(['Query depth limit of 20 exceeded, found 27.']);
    });
  });
});
