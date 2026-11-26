import fs from 'fs';
import path from 'path';

import { expect } from 'chai';
import type { DocumentNode, FieldNode, OperationDefinitionNode } from 'graphql';
import {
  buildSchema,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  parse,
  validate,
} from 'graphql';

import {
  DEFAULT_FIELD_WEIGHT,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_NODES,
  getQueryCost,
  PAGINATED_FIELD_WEIGHT,
  QueryCostOptions,
} from '../../../../server/graphql/cost';
import { getFieldCostExtension, PARENT_LIMIT } from '../../../../server/graphql/cost/extensions';
import { DEFAULT_MAX_LIMIT, resolveLimitArgument } from '../../../../server/graphql/cost/limit';
import schemaV1 from '../../../../server/graphql/v1/schema';
import schemaV2 from '../../../../server/graphql/v2/schema';

const schema = buildSchema(/* GraphQL */ `
  interface Collection {
    offset: Int
    limit: Int
    totalCount: Int
  }

  interface Account {
    id: ID!
    name: String
    members(limit: Int! = 10, offset: Int! = 0): MemberCollection!
  }

  type Individual implements Account {
    id: ID!
    name: String
    members(limit: Int! = 10, offset: Int! = 0): MemberCollection!
    email: String
  }

  type Organization implements Account {
    id: ID!
    name: String
    members(limit: Int! = 10, offset: Int! = 0): MemberCollection!
    website: String
    hostedAccounts(limit: Int! = 20): AccountCollection!
  }

  type AccountCollection implements Collection {
    offset: Int
    limit: Int
    totalCount: Int
    nodes: [Account!]!
  }

  type Member {
    id: ID!
    role: String
    account: Account
  }

  type MemberCollection implements Collection {
    offset: Int
    limit: Int
    totalCount: Int
    nodes: [Member!]!
  }

  type ExpenseItem {
    id: ID!
    amount: Int
  }

  type Expense {
    id: ID!
    description: String
    items(limit: Int): [ExpenseItem!]!
  }

  union SearchResult = Organization | Expense

  type SearchResults {
    total: Int
    collection: AccountCollection!
  }

  type Query {
    account(slug: String!): Account
    accounts(limit: Int! = 10, offset: Int! = 0): AccountCollection!
    expenses(limit: Int): [Expense!]!
    search(term: String!, limit: Int! = 5): [SearchResult!]!
    searchAccounts(term: String!, limit: Int! = 5): SearchResults!
    me: Individual
  }

  type Mutation {
    editAccount(name: String!): Account
    deleteExpense(id: ID!): Expense
  }
`);

const P = PAGINATED_FIELD_WEIGHT;

const getCost = (query: string, options: QueryCostOptions = {}, targetSchema = schema) => {
  const document = parse(query);
  const validationErrors = validate(targetSchema, document);
  expect(validationErrors.map(e => e.message)).to.deep.eq([]);
  return getQueryCost(targetSchema, document, options);
};

/** Cost of `accounts(limit: L) { nodes { id } }` */
const flatAccountsCost = (limit: number) => P + 1 + limit * 1;

describe('server/graphql/cost', () => {
  it('counts 1 per plain field and nothing for an empty selection', () => {
    expect(DEFAULT_FIELD_WEIGHT).to.eq(1);
    const result = getCost('{ me { id name email } }');
    expect(result.cost).to.eq(4);
    expect(result.operationType).to.eq('query');
    expect(result.fields).to.deep.eq([{ responseKey: 'me', fieldName: 'me', cost: 4 }]);
    expect(result.abortReason).to.be.undefined;
    expect(result.error).to.be.undefined;
  });

  describe('limit resolution', () => {
    const query = 'query ($limit: Int!) { accounts(limit: $limit) { nodes { id } } }';
    const queryWithVariableDefault = 'query ($limit: Int! = 8) { accounts(limit: $limit) { nodes { id } } }';

    it('uses the literal value', () => {
      expect(getCost('{ accounts(limit: 5) { nodes { id } } }').cost).to.eq(flatAccountsCost(5));
    });

    it('uses the request variable', () => {
      expect(getCost(query, { variables: { limit: 7 } }).cost).to.eq(flatAccountsCost(7));
      expect(getCost(queryWithVariableDefault, { variables: { limit: 7 } }).cost).to.eq(flatAccountsCost(7));
    });

    it('uses the variable default', () => {
      expect(getCost(queryWithVariableDefault, { variables: {} }).cost).to.eq(flatAccountsCost(8));
      expect(getCost(queryWithVariableDefault).cost).to.eq(flatAccountsCost(8));
    });

    it('uses the schema default', () => {
      expect(getCost('{ accounts { nodes { id } } }').cost).to.eq(flatAccountsCost(10));
      // A variable that is not provided and has no default leaves the argument unset
      const optionalVariable = 'query ($limit: Int) { accounts(limit: $limit) { nodes { id } } }';
      expect(getCost(optionalVariable, { variables: {} }).cost).to.eq(flatAccountsCost(10));
    });

    it('accepts 0, to fetch only totalCount', () => {
      expect(getCost('{ accounts(limit: 0) { totalCount nodes { id } } }').cost).to.eq(P + 1 + 1);
    });

    it('counts invalid values as the maximum limit', () => {
      for (const limit of [null, -1, 1.5, '10', 1e12, NaN, { value: 10 }, [10], true]) {
        expect(getCost(query, { variables: { limit } }).cost, `limit: ${JSON.stringify(limit)}`).to.eq(
          flatAccountsCost(DEFAULT_MAX_LIMIT),
        );
      }

      // Invalid variables objects are treated as no variables
      for (const variables of [null, 'limit', 42, ['limit']]) {
        expect(getCost(queryWithVariableDefault, { variables }).cost).to.eq(flatAccountsCost(8));
      }
    });

    it('counts a missing limit without default as the maximum limit', () => {
      expect(getCost('{ expenses { id } }').cost).to.eq(P + DEFAULT_MAX_LIMIT);
      expect(getCost('{ expenses { id } }', { maxLimit: 50 }).cost).to.eq(P + 50);
    });

    it('reports where the limit comes from', () => {
      const document = parse(
        'query ($a: Int, $b: Int = 3, $c: Int) { a: expenses(limit: 1) { id } b: expenses(limit: $a) { id } c: expenses(limit: $b) { id } d: expenses(limit: $c) { id } e: expenses { id } f: expenses(limit: "x") { id } }',
      );
      const operation = document.definitions[0];
      if (operation.kind !== 'OperationDefinition') {
        throw new Error('Expected an operation');
      }

      const variableDefinitions = new Map(operation.variableDefinitions.map(d => [d.variable.name.value, d]));
      const argDefinition = schema.getQueryType().getFields().expenses.args[0];
      const fieldNodes = operation.selectionSet.selections.filter((s): s is FieldNode => s.kind === 'Field');
      const options = { variables: { a: 2, c: null }, variableDefinitions };
      expect(fieldNodes.map(node => resolveLimitArgument(node, argDefinition, options))).to.deep.eq([
        { value: 1, source: 'literal' },
        { value: 2, source: 'variable' },
        { value: 3, source: 'variableDefault' },
        { value: DEFAULT_MAX_LIMIT, source: 'invalid' },
        { value: DEFAULT_MAX_LIMIT, source: 'missing' },
        { value: DEFAULT_MAX_LIMIT, source: 'invalid' },
      ]);
    });

    it('reads schema defaults declared with `default: { value }` and with the legacy `defaultValue`', () => {
      const programmaticSchema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            modern: { type: GraphQLInt, args: { limit: { type: GraphQLInt, default: { value: 4 } } } },
            legacy: { type: GraphQLInt, args: { limit: { type: GraphQLInt, defaultValue: 6 } } },
            invalid: { type: GraphQLInt, args: { limit: { type: GraphQLInt, default: { value: -3 } } } },
          },
        }),
      });

      const fields = programmaticSchema.getQueryType().getFields();
      const operation = parse('{ field }').definitions[0] as OperationDefinitionNode;
      const fieldNode = operation.selectionSet.selections[0] as FieldNode;
      expect(resolveLimitArgument(fieldNode, fields.modern.args[0])).to.deep.eq({ value: 4, source: 'schemaDefault' });
      expect(resolveLimitArgument(fieldNode, fields.legacy.args[0])).to.deep.eq({ value: 6, source: 'schemaDefault' });
      expect(resolveLimitArgument(fieldNode, fields.invalid.args[0])).to.deep.eq({
        value: DEFAULT_MAX_LIMIT,
        source: 'invalid',
      });
    });
  });

  describe('sizes', () => {
    it('grows linearly with the limit, applied to nodes and not to totalCount, limit or offset', () => {
      const cost = (limit: number) =>
        getCost(`{ accounts(limit: ${limit}) { totalCount limit offset nodes { id name } } }`).cost;
      expect(cost(5)).to.eq(P + 3 + 1 + 5 * 2);
      expect(cost(10) - cost(5)).to.eq(10);
      expect(cost(20) - cost(10)).to.eq(20);
    });

    it('applies the limit to the items of a paginated list', () => {
      expect(getCost('{ expenses(limit: 4) { id description } }').cost).to.eq(P + 4 * 2);
    });

    it('applies the limit to the first list below the paginated field', () => {
      // searchAccounts(limit) > collection > nodes
      expect(
        getCost('{ searchAccounts(term: "x", limit: 7) { total collection { totalCount nodes { id } } } }').cost,
      ).to.eq(P + 1 + (1 + (1 + (1 + 7 * 1))));
    });

    it('multiplies nested limits', () => {
      const cost = (outer: number, inner: number) =>
        getCost(`{ accounts(limit: ${outer}) { nodes { members(limit: ${inner}) { nodes { id } } } } }`).cost;
      const expected = (outer: number, inner: number) => P + 1 + outer * (P + 1 + inner * 1);
      expect(cost(10, 10)).to.eq(expected(10, 10));
      expect(cost(20, 10)).to.eq(expected(20, 10));
      expect(cost(10, 20)).to.eq(expected(10, 20));
      expect(cost(10, 10) - cost(10, 0)).to.eq(10 * 10); // The inner rows count once per outer row
    });

    it('counts nesting more than a flat list returning the same number of rows', () => {
      const flat = getCost('{ accounts(limit: 100) { nodes { id } } }').cost;
      const nested = getCost('{ accounts(limit: 10) { nodes { members(limit: 10) { nodes { id } } } } }').cost;
      expect(nested).to.be.greaterThan(flat);
    });

    it('starts again from the limit of each nested paginated field', () => {
      // The limit of `accounts` must not leak into the `members` collection, which uses its own default (10)
      expect(getCost('{ accounts(limit: 3) { nodes { members { nodes { id } } } } }').cost).to.eq(
        P + 1 + 3 * (P + 1 + 10 * 1),
      );
    });
  });

  describe('fragments', () => {
    it('follows named fragments and nested fragments', () => {
      const query = `
        { me { ...A } }
        fragment A on Individual { id ...B }
        fragment B on Individual { name members(limit: 2) { nodes { ...C } } }
        fragment C on Member { id role }
      `;
      expect(getCost(query).cost).to.eq(1 + (1 + 1 + (P + 1 + 2 * 2)));
    });

    it('counts a field selected several times under the same response key once', () => {
      const query = `
        { me { id name ...F ...F ... on Individual { id ...F } } }
        fragment F on Individual { id email name }
      `;
      expect(getCost(query).cost).to.eq(1 + 3);
    });

    it('merges the sub-selections of a field selected several times', () => {
      const query = `
        { me { members(limit: 2) { nodes { id } } ...F } }
        fragment F on Individual { members(limit: 2) { nodes { role } } }
      `;
      expect(getCost(query).cost).to.eq(1 + (P + 1 + 2 * 2));
    });

    it('counts the same fragment spread under different fields each time', () => {
      const query = `
        { a: me { ...F } b: me { ...F } }
        fragment F on Individual { id email }
      `;
      const result = getCost(query);
      expect(result.cost).to.eq(6);
      expect(result.fields).to.deep.eq([
        { responseKey: 'a', fieldName: 'me', cost: 3 },
        { responseKey: 'b', fieldName: 'me', cost: 3 },
      ]);
    });

    it('counts interfaces as their most expensive possible type', () => {
      const query = `
        {
          account(slug: "x") {
            id
            ... on Individual { email name }
            ... on Organization { website hostedAccounts(limit: 3) { nodes { id } } }
          }
        }
      `;
      // Individual: id + email + name = 3, Organization: id + website + hostedAccounts (10 + 1 + 3) = 16
      expect(getCost(query).cost).to.eq(1 + 16);
    });

    it('counts unions as their most expensive possible type', () => {
      const query = `
        {
          search(term: "x", limit: 4) {
            __typename
            ... on Organization { id name }
            ...ExpenseFields
          }
        }
        fragment ExpenseFields on Expense { id description items(limit: 2) { id amount } }
      `;
      // Organization: 2, Expense: id + description + items (10 + 2 * 2) = 16
      expect(getCost(query).cost).to.eq(P + 4 * 16);
    });

    it('handles fragments on the interface inside an interface selection', () => {
      const query = `
        { account(slug: "x") { ...AccountFields ... on Account { name } } }
        fragment AccountFields on Account { id name }
      `;
      expect(getCost(query).cost).to.eq(1 + 2);
    });

    it('keeps nested abstract types and repeated fragments cheap to analyze', () => {
      // Each level selects a different field on each possible type. Without caching this is exponential.
      const depth = 15;
      const fragments = Array.from(
        { length: depth },
        (_, i) => `
          fragment F${i} on Account {
            id
            ... on Individual { a: members(limit: 2) { nodes { account { ${i + 1 < depth ? `...F${i + 1}` : 'id'} } } } }
            ... on Organization { b: members(limit: 2) { nodes { account { ${i + 1 < depth ? `...F${i + 1}` : 'id'} } } } }
          }
        `,
      ).join('\n');
      const result = getCost(`{ account(slug: "x") { ...F0 } } ${fragments}`);
      expect(result.abortReason).to.be.undefined;
      expect(result.visitedNodes).to.be.lessThan(1000);
      expect(result.cost).to.be.greaterThan(2 ** depth);
    });
  });

  it('counts aliases of the same field with different arguments each', () => {
    const result = getCost('{ a: accounts(limit: 5) { nodes { id } } b: accounts(limit: 50) { nodes { id } } }');
    expect(result.cost).to.eq(flatAccountsCost(5) + flatAccountsCost(50));
    expect(result.fields).to.deep.eq([
      { responseKey: 'a', fieldName: 'accounts', cost: flatAccountsCost(5) },
      { responseKey: 'b', fieldName: 'accounts', cost: flatAccountsCost(50) },
    ]);
  });

  it('ignores @skip and @include', () => {
    const query = 'query ($no: Boolean! = false) { me { id email @skip(if: true) name @include(if: $no) } }';
    expect(getCost(query).cost).to.eq(4);
  });

  it('does not count introspection fields and __typename', () => {
    const result = getCost(
      '{ __typename __schema { types { name fields { name } } } __type(name: "Account") { name } me { __typename id } }',
    );
    expect(result.cost).to.eq(2);
    expect(result.fields.map(f => [f.responseKey, f.cost])).to.deep.eq([
      ['__typename', 0],
      ['__schema', 0],
      ['__type', 0],
      ['me', 2],
    ]);
  });

  describe('operations', () => {
    const document = `
      query GetAccounts { accounts(limit: 2) { nodes { id } } }
      query GetMe { me { id } }
      mutation EditAccount { editAccount(name: "x") { id members(limit: 2) { nodes { id } } } }
    `;

    it('picks the operation by name', () => {
      expect(getCost(document, { operationName: 'GetAccounts' })).to.deep.include({
        cost: flatAccountsCost(2),
        operationName: 'GetAccounts',
        operationType: 'query',
      });
      expect(getCost(document, { operationName: 'GetMe' }).cost).to.eq(2);
    });

    it('analyzes mutations', () => {
      expect(getCost(document, { operationName: 'EditAccount' })).to.deep.include({
        cost: 1 + (1 + (P + 1 + 2 * 1)),
        operationType: 'mutation',
      });
    });

    it('reports an error without cost when the operation cannot be determined', () => {
      const withoutName = getCost(document);
      expect(withoutName).to.deep.include({ cost: 0, error: 'Could not determine the operation' });
      const unknown = getCost(document, { operationName: 'Nope' });
      expect(unknown).to.deep.include({ cost: 0, error: 'Unknown operation "Nope"' });
    });

    it('reports an error when the schema does not support the operation type', () => {
      const result = getQueryCost(schema, parse('subscription { me { id } }'));
      expect(result).to.deep.include({ cost: 0, operationType: 'subscription' });
      expect(result.error).to.eq('The schema does not support subscription operations');
    });
  });

  describe('analysis limits', () => {
    it('stops at the node cap and counts as over budget', () => {
      const fields = Array.from({ length: DEFAULT_MAX_NODES }, (_, i) => `a${i}: me { id }`).join('\n');
      const result = getQueryCost(schema, parse(`{ ${fields} }`));
      expect(result.cost).to.eq(Infinity);
      expect(result.abortReason).to.eq('MAX_NODES');
      expect(result.visitedNodes).to.eq(DEFAULT_MAX_NODES + 1);
    });

    it('accepts a custom node cap', () => {
      const query = '{ a: me { id } b: me { id } c: me { id } }';
      expect(getQueryCost(schema, parse(query), { maxNodes: 6 }).cost).to.eq(6);
      expect(getQueryCost(schema, parse(query), { maxNodes: 5 })).to.deep.include({
        cost: Infinity,
        abortReason: 'MAX_NODES',
      });
    });

    it('stops at the maximum depth and counts as over budget', () => {
      const nested = (depth: number) =>
        `{ me { ${'members { nodes { account { '.repeat(depth)}id${' } } }'.repeat(depth)} } }`;
      // The operation's selection set is at depth 1 and `me`'s at depth 2. Each repetition nests 3 more.
      const maxRepetitions = Math.floor((DEFAULT_MAX_DEPTH - 2) / 3);
      expect(getQueryCost(schema, parse(nested(maxRepetitions))).abortReason).to.be.undefined;
      expect(getQueryCost(schema, parse(nested(maxRepetitions + 1)))).to.deep.include({
        cost: Infinity,
        abortReason: 'MAX_DEPTH',
      });
      expect(getQueryCost(schema, parse(nested(200))).abortReason).to.eq('MAX_DEPTH');
    });
  });

  describe('bad input', () => {
    it('never throws', () => {
      const badInputs: Array<[GraphQLSchema, DocumentNode]> = [
        [schema, null],
        [schema, {} as DocumentNode],
        [schema, { kind: 'Document', definitions: null } as unknown as DocumentNode],
        [null, parse('{ me { id } }')],
        [{} as GraphQLSchema, parse('{ me { id } }')],
      ];

      for (const [badSchema, badDocument] of badInputs) {
        const result = getQueryCost(badSchema, badDocument);
        expect(result).to.be.an('object');
        expect(result.error).to.be.a('string');
      }
    });

    it('ignores unknown fields, unknown fragments and unknown type conditions', () => {
      const query = `
        { me { id unknown { id } ...Unknown ... on UnknownType { id } } unknownRoot(limit: 1000) { id } }
      `;
      expect(getQueryCost(schema, parse(query)).cost).to.eq(2);
    });

    it('does not loop on fragment cycles', () => {
      const query = `
        { me { ...A } }
        fragment A on Individual { id ...B }
        fragment B on Individual { name ...A }
      `;
      const result = getQueryCost(schema, parse(query));
      expect(result.cost).to.eq(3);
    });
  });

  describe('extensions.cost', () => {
    it('reads valid weights and ignores invalid ones', () => {
      const field = (cost: unknown) =>
        ({ extensions: { cost } }) as unknown as Parameters<typeof getFieldCostExtension>[0];
      expect(getFieldCostExtension(field({ weight: 50 }))).to.deep.eq({ weight: 50 });
      expect(getFieldCostExtension(field({ weight: 0 }))).to.deep.eq({ weight: 0 });
      for (const invalid of [undefined, null, 'heavy', 12, { weight: -1 }, { weight: '50' }, { weight: Infinity }]) {
        expect(getFieldCostExtension(field(invalid))).to.deep.eq({});
      }
      expect(getFieldCostExtension(null)).to.deep.eq({});
    });

    it('uses the declared weight instead of the default one', () => {
      const weightedSchema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            cheap: { type: GraphQLInt },
            expensive: { type: GraphQLInt, extensions: { cost: { weight: 50 } } },
            paginatedButCheap: {
              type: GraphQLInt,
              args: { limit: { type: GraphQLInt } },
              extensions: { cost: { weight: 2 } },
            },
          },
        }),
      });

      expect(getQueryCost(weightedSchema, parse('{ cheap expensive paginatedButCheap }')).cost).to.eq(1 + 50 + 2);
    });
  });

  describe('extensions.cost.listSize', () => {
    const Tag = new GraphQLObjectType({ name: 'Tag', fields: { id: { type: GraphQLID } } });
    const tagList = (listSize?: number | typeof PARENT_LIMIT) => ({
      type: new GraphQLNonNull(new GraphQLList(Tag)),
      ...(listSize === undefined ? {} : { extensions: { cost: { listSize } } }),
    });
    const Item = new GraphQLObjectType({
      name: 'Item',
      fields: { id: { type: GraphQLID }, tags: tagList(5) },
    });
    const TagCollection = new GraphQLObjectType({
      name: 'TagCollection',
      fields: { totalCount: { type: GraphQLInt }, nodes: tagList() },
    });
    const ItemCollection = new GraphQLObjectType({
      name: 'ItemCollection',
      fields: {
        totalCount: { type: GraphQLInt },
        nodes: { type: new GraphQLList(Item) },
        // Next to `nodes`, but not one per item of the page
        tags: tagList(3),
        // One per item of the page
        scores: tagList(PARENT_LIMIT),
        // A single object without arguments, which the limit passes through
        summary: {
          type: new GraphQLObjectType({ name: 'ItemSummary', fields: { topTags: tagList(2), allTags: tagList() } }),
        },
      },
    });
    const listSizeSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          items: { type: ItemCollection, args: { limit: { type: GraphQLInt, defaultValue: 10 } } },
          item: { type: Item },
          tags: tagList(4),
          noTags: tagList(0),
          undeclaredTags: tagList(),
          tagCollection: { type: TagCollection, extensions: { cost: { listSize: 6 } } },
          paginatedTags: {
            type: tagList().type,
            args: { limit: { type: GraphQLInt, defaultValue: 7 } },
            extensions: { cost: { listSize: 1000 } },
          },
        },
      }),
    });

    const cost = (query: string) => getCost(query, {}, listSizeSchema).cost;

    it('reads valid sizes and ignores invalid ones', () => {
      const field = (cost: unknown) =>
        ({ extensions: { cost } }) as unknown as Parameters<typeof getFieldCostExtension>[0];
      expect(getFieldCostExtension(field({ listSize: 20 }))).to.deep.eq({ listSize: 20 });
      expect(getFieldCostExtension(field({ listSize: 0 }))).to.deep.eq({ listSize: 0 });
      expect(getFieldCostExtension(field({ listSize: PARENT_LIMIT }))).to.deep.eq({ listSize: PARENT_LIMIT });
      expect(getFieldCostExtension(field({ weight: 3, listSize: 20 }))).to.deep.eq({ weight: 3, listSize: 20 });
      for (const invalid of [-1, 1.5, Infinity, NaN, '20', 'limit', null]) {
        expect(getFieldCostExtension(field({ listSize: invalid }))).to.deep.eq({});
      }
    });

    it('multiplies the children of a list by its declared size', () => {
      expect(cost('{ tags { id } }')).to.eq(1 + 4 * 1);
      expect(cost('{ noTags { id } }')).to.eq(1);
      expect(cost('{ undeclaredTags { id } }')).to.eq(1 + 1);
    });

    it('applies the size of a collection without limit to its nodes', () => {
      expect(cost('{ tagCollection { totalCount nodes { id } } }')).to.eq(1 + 1 + (1 + 6 * 1));
    });

    it('multiplies an unpaginated list nested in a paginated one', () => {
      // items(limit) > nodes > tags (listSize 5)
      const nested = (limit: number) => cost(`{ items(limit: ${limit}) { nodes { id tags { id } } } }`);
      expect(nested(10)).to.eq(P + 1 + 10 * (1 + (1 + 5 * 1)));
      expect(nested(20) - nested(10)).to.eq(10 * (1 + 1 + 5 * 1));
      expect(cost('{ items { nodes { tags { id } } } }')).to.eq(nested(10) - 10); // Schema default, without `id`
    });

    it('does not multiply a sized list next to nodes by the limit of the collection', () => {
      expect(cost('{ items(limit: 100) { tags { id } } }')).to.eq(P + (1 + 3 * 1));
      expect(cost('{ items(limit: 100) { summary { topTags { id } } } }')).to.eq(P + 1 + (1 + 2 * 1));
    });

    it('applies the limit of the collection to lists declared with PARENT_LIMIT and to undeclared ones', () => {
      expect(cost('{ items(limit: 100) { scores { id } } }')).to.eq(P + (1 + 100 * 1));
      expect(cost('{ items(limit: 100) { summary { allTags { id } } } }')).to.eq(P + 1 + (1 + 100 * 1));
      // Without an enclosing limit, they count as a single item
      expect(cost('{ item { tags { id } } }')).to.eq(1 + (1 + 5 * 1));
    });

    it('uses the limit rather than the size on paginated fields', () => {
      expect(cost('{ paginatedTags { id } }')).to.eq(P + 7 * 1);
      expect(cost('{ paginatedTags(limit: 2) { id } }')).to.eq(P + 2 * 1);
    });
  });

  describe('real schemas', () => {
    it('works on the V1 schema', () => {
      expect(getCost('{ allMembers(limit: 5) { id role } }', {}, schemaV1).cost).to.eq(P + 5 * 2);
      expect(getCost('{ search(term: "x", limit: 3) { total collectives { id slug } } }', {}, schemaV1).cost).to.eq(
        P + 1 + (1 + 3 * 2),
      );
    });

    it('works on the V2 schema', () => {
      expect(getCost('{ accounts(limit: 5) { totalCount nodes { id slug } } }', {}, schemaV2).cost).to.eq(
        P + 1 + (1 + 5 * 2),
      );
    });

    it('analyzes the largest frontend query in a few milliseconds', () => {
      // Copied from `ExpensePage` in opencollective-frontend/components/expenses/graphql/queries.ts, fragments inlined
      const query = fs.readFileSync(path.join(__dirname, 'fixtures/ExpensePage.graphql'), 'utf8');
      const document = parse(query);
      expect(validate(schemaV2, document).map(e => e.message)).to.deep.eq([]);

      const options = { variables: { legacyExpenseId: 42 } };
      getQueryCost(schemaV2, document, options); // Warm up
      const durations = Array.from({ length: 10 }, () => {
        const start = process.hrtime.bigint();
        const result = getQueryCost(schemaV2, document, options);
        expect(result.abortReason).to.be.undefined;
        expect(result.error).to.be.undefined;
        expect(result.cost).to.be.greaterThan(0);
        return Number(process.hrtime.bigint() - start) / 1e6;
      });

      const median = durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)];
      expect(median).to.be.lessThan(10);
    });
  });
});
