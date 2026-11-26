/**
 * Per-field weights of the V2 schema, declared with `extensions.cost.weight` (see `CostTier`).
 *
 * GraphQL V1 is not weighted: per-field costs are for V2 only (see opencollective/opencollective#9079).
 */
import { expect } from 'chai';
import type { GraphQLField, GraphQLInterfaceType, GraphQLObjectType, GraphQLSchema } from 'graphql';
import { isInterfaceType, isObjectType, parse } from 'graphql';
import { invert } from 'lodash';

import { getQueryCost, PAGINATED_FIELD_WEIGHT } from '../../../../server/graphql/cost';
import { CostTier, getFieldCostExtension } from '../../../../server/graphql/cost/extensions';
import schemaV1 from '../../../../server/graphql/v1/schema';
import schemaV2 from '../../../../server/graphql/v2/schema';

type AnyField = GraphQLField<unknown, unknown>;

const TIER_NAMES = invert(CostTier) as Record<string, keyof typeof CostTier>;

const getCost = (query: string): number => {
  const result = getQueryCost(schemaV2, parse(query));
  expect(result.error).to.be.undefined;
  return result.cost;
};

const getCompositeTypes = (schema: GraphQLSchema): (GraphQLObjectType | GraphQLInterfaceType)[] =>
  Object.values(schema.getTypeMap()).filter(
    (type): type is GraphQLObjectType | GraphQLInterfaceType =>
      !type.name.startsWith('__') && (isObjectType(type) || isInterfaceType(type)),
  );

/** All the fields that declare a weight, as `Type.field` => weight */
const getDeclaredWeights = (schema: GraphQLSchema): Map<string, { weight: unknown; type; field: AnyField }> => {
  const weights = new Map();
  for (const type of getCompositeTypes(schema)) {
    for (const field of Object.values(type.getFields()) as AnyField[]) {
      const weight = (field.extensions?.cost as Record<string, unknown> | undefined)?.weight;
      if (weight !== undefined) {
        weights.set(`${type.name}.${field.name}`, { weight, type, field });
      }
    }
  }
  return weights;
};

/** Whether the field comes from an interface of its type that declares the same weight */
const isInheritedWeight = (type: GraphQLObjectType | GraphQLInterfaceType, field: AnyField): boolean =>
  type
    .getInterfaces()
    .some(
      parent =>
        getFieldCostExtension(parent.getFields()[field.name] as AnyField).weight ===
        getFieldCostExtension(field).weight,
    );

describe('server/graphql/cost weights', () => {
  it('only uses named tiers', () => {
    const problems = [...getDeclaredWeights(schemaV2)]
      .filter(([, { weight }]) => typeof weight !== 'number' || !TIER_NAMES[weight])
      .map(([name, { weight }]) => `${name} has weight ${JSON.stringify(weight)}, use a CostTier`);
    expect(problems).to.deep.eq([]);
  });

  it('declares the same weight on a field and on the interfaces it implements', () => {
    const problems = [];
    for (const type of getCompositeTypes(schemaV2)) {
      for (const field of Object.values(type.getFields()) as AnyField[]) {
        for (const parent of type.getInterfaces()) {
          const parentField = parent.getFields()[field.name] as AnyField;
          const weight = getFieldCostExtension(field).weight;
          const parentWeight = parentField && getFieldCostExtension(parentField).weight;
          if (parentField && weight !== parentWeight) {
            problems.push(`${type.name}.${field.name} (${weight}) != ${parent.name}.${field.name} (${parentWeight})`);
          }
        }
      }
    }
    expect(problems).to.deep.eq([]);
  });

  it('does not weight the V1 schema', () => {
    expect([...getDeclaredWeights(schemaV1).keys()]).to.deep.eq([]);
  });

  it('gives paginated fields the Query tier', () => {
    expect(PAGINATED_FIELD_WEIGHT).to.eq(CostTier.Query);
  });

  it('matches the snapshot of every weighted field and its tier', () => {
    // Fields inherited from an interface are listed once, on the interface
    const tiers = [...getDeclaredWeights(schemaV2)]
      .filter(([, { type, field }]) => !isInheritedWeight(type, field))
      .map(([name, { weight }]) => `${name}: ${TIER_NAMES[weight as number]}`)
      .sort();

    expect(tiers.join('\n')).to.matchSnapshot();
  });

  describe('costs', () => {
    const N = 100;
    const statsSelection = 'stats { balance { valueInCents } totalAmountReceived { valueInCents } }';

    it('a stats field inside a list of N accounts costs N times the stats field alone', () => {
      const alone = getCost(`{ account(slug: "x") { ${statsSelection} } }`);
      const inList = getCost(`{ accounts(limit: ${N}) { nodes { ${statsSelection} } } }`);

      // Remove the cost of `account`, and of `accounts` and `nodes`
      expect(inList - PAGINATED_FIELD_WEIGHT - CostTier.Default).to.eq(N * (alone - CostTier.Default));
      expect(alone - CostTier.Default).to.eq(1 + 2 * (CostTier.Query + 1));
    });

    it('fetching N updates stays far cheaper than fetching stats for N accounts', () => {
      const updates = getCost(`{ account(slug: "x") { updates(limit: ${N}) { nodes { id title } } } }`);
      const stats = getCost(`{ accounts(limit: ${N}) { nodes { ${statsSelection} } } }`);
      expect(stats).to.be.greaterThan(10 * updates);
    });

    it('a stat batched by a loader costs less than the same kind of stat computed once per account', () => {
      const batched = getCost(`{ accounts(limit: ${N}) { nodes { stats { totalAmountSpent { valueInCents } } } } }`);
      const unbatched = getCost(`{ accounts(limit: ${N}) { nodes { stats { totalPaidExpenses { valueInCents } } } } }`);
      expect(unbatched - batched).to.eq(N * (CostTier.Aggregate - CostTier.Query));
    });

    it('host reports cost more than account stats', () => {
      const hostStats = getCost('{ host(slug: "x") { hostStats { totalAmountReceived { valueInCents } } } }');
      const accountStats = getCost(`{ account(slug: "x") { stats { totalAmountReceived { valueInCents } } } }`);
      expect(hostStats).to.be.greaterThan(10 * accountStats);
    });
  });
});
