/**
 * Maximum `limit` of each field, enforced by the cost analyzer (see opencollective/opencollective#9087). The HTTP
 * behaviour (log-only and rejection modes, root exemption) is tested in `test/server/routes/graphql.test.ts`.
 */
import { expect } from 'chai';
import type { GraphQLField, GraphQLInterfaceType, GraphQLObjectType, GraphQLSchema as Schema } from 'graphql';
import {
  GraphQLID,
  GraphQLInt,
  GraphQLInterfaceType as InterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType as ObjectType,
  GraphQLSchema,
  isInterfaceType,
  isObjectType,
  parse,
  validate,
} from 'graphql';

import { getQueryCost, PAGINATED_FIELD_WEIGHT, QueryCostOptions } from '../../../../server/graphql/cost';
import { getFieldCostExtension } from '../../../../server/graphql/cost/extensions';
import { DEFAULT_MAX_LIMIT, resolveLimitArgument } from '../../../../server/graphql/cost/limit';
import schemaV1 from '../../../../server/graphql/v1/schema';
import schemaV2 from '../../../../server/graphql/v2/schema';

type AnyField = GraphQLField<unknown, unknown>;

const P = PAGINATED_FIELD_WEIGHT;

const limitArgs = (defaultValue = 10) => ({
  limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue },
  offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
});

const Item = new ObjectType({ name: 'Item', fields: { id: { type: GraphQLID } } });

const ItemCollection = new ObjectType({
  name: 'ItemCollection',
  fields: { totalCount: { type: GraphQLInt }, nodes: { type: new GraphQLNonNull(new GraphQLList(Item)) } },
});

const Node = new InterfaceType({
  name: 'Node',
  fields: () => ({
    id: { type: GraphQLID },
    items: { type: ItemCollection, args: limitArgs() },
  }),
});

const nodeFields = () => ({
  id: { type: GraphQLID },
  items: { type: ItemCollection, args: limitArgs() },
  // Allows more than the default maximum
  exports: { type: ItemCollection, args: limitArgs(100), extensions: { cost: { maxLimit: 5000 } } },
  // Allows less than the default maximum
  children: { type: ItemCollection, args: limitArgs(), extensions: { cost: { maxLimit: 100 } } },
});

const Account = new ObjectType({ name: 'Account', interfaces: [Node], fields: nodeFields });
const Host = new ObjectType({ name: 'Host', interfaces: [Node], fields: nodeFields });

const AccountCollection = new ObjectType({
  name: 'AccountCollection',
  fields: { totalCount: { type: GraphQLInt }, nodes: { type: new GraphQLList(Account) } },
});

const schema = new GraphQLSchema({
  types: [Account, Host],
  query: new ObjectType({
    name: 'Query',
    fields: {
      node: { type: Node },
      account: { type: Account },
      accounts: { type: AccountCollection, args: limitArgs() },
      exports: { type: ItemCollection, args: limitArgs(100), extensions: { cost: { maxLimit: 5000 } } },
      nullableLimit: { type: new GraphQLList(Item), args: { limit: { type: GraphQLInt } } },
      tooLargeDefault: { type: new GraphQLList(Item), args: limitArgs(2000) },
    },
  }),
});

const analyze = (query: string, options: QueryCostOptions = {}, targetSchema: Schema = schema) => {
  const document = parse(query);
  expect(validate(targetSchema, document).map(e => e.message)).to.deep.eq([]);
  const result = getQueryCost(targetSchema, document, options);
  expect(result.error).to.be.undefined;
  return result;
};

const violations = (query: string, options: QueryCostOptions = {}, targetSchema: Schema = schema) =>
  analyze(query, options, targetSchema).limitViolations;

describe('server/graphql/cost max limit', () => {
  it('uses 1000 as the default maximum', () => {
    expect(DEFAULT_MAX_LIMIT).to.eq(1000);
  });

  describe('extensions.cost.maxLimit', () => {
    const field = (cost: unknown) => ({ extensions: { cost } }) as unknown as AnyField;

    it('reads valid maximums and ignores invalid ones', () => {
      expect(getFieldCostExtension(field({ maxLimit: 5000 }))).to.deep.eq({ maxLimit: 5000 });
      expect(getFieldCostExtension(field({ weight: 10, maxLimit: 50 }))).to.deep.eq({ weight: 10, maxLimit: 50 });
      for (const invalid of [0, -1, 1.5, Infinity, NaN, '5000', null]) {
        expect(getFieldCostExtension(field({ maxLimit: invalid }))).to.deep.eq({});
      }
    });
  });

  describe('at the root', () => {
    it('accepts limits up to the maximum, including 0', () => {
      expect(violations('{ accounts(limit: 1000) { nodes { id } } }')).to.deep.eq([]);
      expect(violations('{ accounts(limit: 0) { totalCount } }')).to.deep.eq([]);
      expect(violations('{ accounts { nodes { id } } }')).to.deep.eq([]);
    });

    it('reports a literal limit above the maximum', () => {
      expect(violations('{ accounts(limit: 1001) { nodes { id } } }')).to.deep.eq([
        { coordinate: 'Query.accounts', responseKey: 'accounts', limit: 1001, maxLimit: 1000, source: 'literal' },
      ]);
    });

    it('reports a variable limit above the maximum', () => {
      const query = 'query ($limit: Int!) { accounts(limit: $limit) { nodes { id } } }';
      expect(violations(query, { variables: { limit: 1000 } })).to.deep.eq([]);
      expect(violations(query, { variables: { limit: 5000 } })).to.deep.eq([
        { coordinate: 'Query.accounts', responseKey: 'accounts', limit: 5000, maxLimit: 1000, source: 'variable' },
      ]);
    });

    it('reports a variable default above the maximum', () => {
      const query = 'query ($limit: Int! = 2000) { accounts(limit: $limit) { nodes { id } } }';
      expect(violations(query)).to.deep.include.members([
        {
          coordinate: 'Query.accounts',
          responseKey: 'accounts',
          limit: 2000,
          maxLimit: 1000,
          source: 'variableDefault',
        },
      ]);
    });

    it('reports a schema default above the maximum', () => {
      expect(violations('{ tooLargeDefault { id } }')).to.deep.eq([
        {
          coordinate: 'Query.tooLargeDefault',
          responseKey: 'tooLargeDefault',
          limit: 2000,
          maxLimit: 1000,
          source: 'schemaDefault',
        },
      ]);
    });

    it('does not report limits it cannot determine, which count as the maximum', () => {
      const query = 'query ($limit: Int) { nullableLimit(limit: $limit) { id } }';
      for (const variables of [{}, { limit: null }, { limit: -1 }, { limit: 1.5 }, { limit: '5000' }]) {
        const result = analyze(query, { variables });
        expect(result.limitViolations).to.deep.eq([]);
        expect(result.cost).to.eq(P + DEFAULT_MAX_LIMIT);
      }
    });

    it('names each alias', () => {
      const result = violations('{ a: accounts(limit: 1001) { totalCount } b: accounts(limit: 1002) { totalCount } }');
      expect(result.map(v => [v.responseKey, v.limit])).to.deep.eq([
        ['a', 1001],
        ['b', 1002],
      ]);
    });

    it('still counts the requested limit in the cost', () => {
      expect(analyze('{ accounts(limit: 2000) { nodes { id } } }').cost).to.eq(P + 1 + 2000);
    });
  });

  describe('nested', () => {
    it('reports a literal limit above the maximum', () => {
      expect(violations('{ accounts(limit: 10) { nodes { items(limit: 1500) { nodes { id } } } } }')).to.deep.eq([
        { coordinate: 'Account.items', responseKey: 'items', limit: 1500, maxLimit: 1000, source: 'literal' },
      ]);
    });

    it('reports a variable limit above the maximum', () => {
      const query = 'query ($n: Int!) { accounts(limit: 10) { nodes { items(limit: $n) { nodes { id } } } } }';
      expect(violations(query, { variables: { n: 1000 } })).to.deep.eq([]);
      expect(violations(query, { variables: { n: 1001 } })).to.deep.eq([
        { coordinate: 'Account.items', responseKey: 'items', limit: 1001, maxLimit: 1000, source: 'variable' },
      ]);
    });

    it('reports every field above its maximum, at the root and nested', () => {
      const query = '{ accounts(limit: 2000) { nodes { items(limit: 3000) { totalCount } } } }';
      expect(violations(query).map(v => v.coordinate)).to.deep.eq(['Query.accounts', 'Account.items']);
    });

    it('reports a field once, even when spread through fragments in several places or on several types', () => {
      const query = /* GraphQL */ `
        query {
          node {
            ... on Account {
              ...Items
            }
            ... on Host {
              ...Items
            }
          }
          account {
            ...Items
          }
          accounts {
            nodes {
              ...Items
            }
          }
        }
        fragment Items on Node {
          items(limit: 1001) {
            nodes {
              id
            }
          }
        }
      `;
      expect(violations(query)).to.deep.eq([
        // Named after the first type it was found on
        { coordinate: 'Account.items', responseKey: 'items', limit: 1001, maxLimit: 1000, source: 'literal' },
      ]);
    });
  });

  describe('fields with their own maximum', () => {
    it('accept values up to it', () => {
      expect(violations('{ exports(limit: 5000) { nodes { id } } }')).to.deep.eq([]);
      expect(violations('{ account { exports(limit: 5000) { nodes { id } } } }')).to.deep.eq([]);
      expect(
        violations('query ($n: Int!) { account { exports(limit: $n) { totalCount } } }', { variables: { n: 5000 } }),
      ).to.deep.eq([]);
    });

    it('report values above it', () => {
      expect(violations('{ account { exports(limit: 5001) { nodes { id } } } }')).to.deep.eq([
        { coordinate: 'Account.exports', responseKey: 'exports', limit: 5001, maxLimit: 5000, source: 'literal' },
      ]);
    });

    it('can allow less than the default maximum', () => {
      expect(violations('{ account { children(limit: 100) { totalCount } } }')).to.deep.eq([]);
      expect(violations('{ account { children(limit: 101) { totalCount } } }')).to.deep.eq([
        { coordinate: 'Account.children', responseKey: 'children', limit: 101, maxLimit: 100, source: 'literal' },
      ]);
    });

    it('count their maximum when the limit cannot be determined', () => {
      const field = (schema.getType('Account') as GraphQLObjectType).getFields().exports;
      const fieldNode = parse('{ exports(limit: "x") { totalCount } }').definitions[0]['selectionSet'].selections[0];
      const limitArgument = field.args.find(arg => arg.name === 'limit');
      expect(resolveLimitArgument(fieldNode, limitArgument, { maxLimit: 5000 })).to.deep.eq({
        value: 5000,
        source: 'invalid',
      });
      const document = parse('query ($n: Int!) { exports(limit: $n) { nodes { id } } }');
      expect(getQueryCost(schema, document, { variables: { n: -1 } }).cost).to.eq(P + 1 + 5000);
    });
  });

  describe('V2 schema', () => {
    const getCompositeTypes = (targetSchema: Schema): (GraphQLObjectType | GraphQLInterfaceType)[] =>
      Object.values(targetSchema.getTypeMap()).filter(
        (type): type is GraphQLObjectType | GraphQLInterfaceType =>
          !type.name.startsWith('__') && (isObjectType(type) || isInterfaceType(type)),
      );

    /** All the fields that take a `limit`, with their maximum */
    const getLimitFields = (targetSchema: Schema) =>
      getCompositeTypes(targetSchema).flatMap(type =>
        (Object.values(type.getFields()) as AnyField[])
          .filter(field => field.args.some(arg => arg.name === 'limit'))
          .map(field => ({ type, field, maxLimit: getFieldCostExtension(field).maxLimit })),
      );

    it('declares the same maximum on a field and on the interfaces it implements', () => {
      const problems = [];
      for (const type of getCompositeTypes(schemaV2)) {
        for (const field of Object.values(type.getFields()) as AnyField[]) {
          for (const parent of type.getInterfaces()) {
            const parentField = parent.getFields()[field.name] as AnyField;
            const maxLimit = getFieldCostExtension(field).maxLimit;
            const parentMaxLimit = parentField && getFieldCostExtension(parentField).maxLimit;
            if (parentField && maxLimit !== parentMaxLimit) {
              problems.push(
                `${type.name}.${field.name} (${maxLimit}) != ${parent.name}.${field.name} (${parentMaxLimit})`,
              );
            }
          }
        }
      }
      expect(problems).to.deep.eq([]);
    });

    it('only declares maximums on fields that take a limit', () => {
      const problems = getCompositeTypes(schemaV2).flatMap(type =>
        (Object.values(type.getFields()) as AnyField[])
          .filter(field => field.extensions?.cost?.maxLimit !== undefined)
          .filter(field => !field.args.some(arg => arg.name === 'limit') || !getFieldCostExtension(field).maxLimit)
          .map(field => `${type.name}.${field.name}`),
      );
      expect(problems).to.deep.eq([]);
    });

    it('has no default limit above the maximum of its field', () => {
      const problems = getLimitFields(schemaV2)
        .map(({ type, field, maxLimit }) => {
          const fieldNode = parse(`{ ${field.name} }`).definitions[0]['selectionSet'].selections[0];
          const limitArgument = field.args.find(arg => arg.name === 'limit');
          const { value, source } = resolveLimitArgument(fieldNode, limitArgument);
          return { name: `${type.name}.${field.name}`, value, source, maxLimit: maxLimit ?? DEFAULT_MAX_LIMIT };
        })
        .filter(({ value, source, maxLimit }) => source === 'schemaDefault' && value > maxLimit)
        .map(({ name, value, maxLimit }) => `${name}: default ${value} > max ${maxLimit}`);
      expect(problems).to.deep.eq([]);
    });

    it('matches the snapshot of every field with its own maximum', () => {
      // Fields inherited from an interface are listed once, on the interface
      const isInherited = (type: GraphQLObjectType | GraphQLInterfaceType, field: AnyField) =>
        type.getInterfaces().some(parent => parent.getFields()[field.name]);
      const fields = getLimitFields(schemaV2)
        .filter(({ maxLimit, type, field }) => maxLimit !== undefined && !isInherited(type, field))
        .map(({ type, field, maxLimit }) => `${type.name}.${field.name}: ${maxLimit}`)
        .sort();

      expect(fields.join('\n')).to.matchSnapshot();
    });

    it('does not declare maximums on the V1 schema, where limits are not checked', () => {
      expect(getLimitFields(schemaV1).filter(({ maxLimit }) => maxLimit !== undefined)).to.deep.eq([]);
    });

    it('enforces the maximums of the real fields', () => {
      const check = (query: string) => violations(query, {}, schemaV2).map(v => `${v.coordinate}: ${v.limit}`);
      expect(check('{ accounts(limit: 1000) { totalCount } }')).to.deep.eq([]);
      expect(check('{ accounts(limit: 1001) { totalCount } }')).to.deep.eq(['Query.accounts: 1001']);
      expect(check('{ transactions(limit: 10000) { totalCount } }')).to.deep.eq([]);
      expect(check('{ transactions(limit: 10001) { totalCount } }')).to.deep.eq(['Query.transactions: 10001']);
      expect(
        check(
          '{ account(slug: "x") { transactions(limit: 10000) { totalCount } childrenAccounts(limit: 101) { totalCount } } }',
        ),
      ).to.deep.eq(['Account.childrenAccounts: 101']);
      expect(check('{ collective(slug: "x") { transactions(limit: 10001) { totalCount } } }')).to.deep.eq([
        'Collective.transactions: 10001',
      ]);
      expect(check('{ search(searchTerm: "x") { results { accounts(limit: 51) { maxScore } } } }')).to.deep.eq([
        'SearchResults.accounts: 51',
      ]);
    });
  });
});
