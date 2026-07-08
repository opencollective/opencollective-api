import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLOutputType,
  GraphQLString,
} from 'graphql';
import { GraphQLDate } from 'graphql-scalars';

import {
  AccountReferenceInput,
  fetchAccountsIdsWithReference,
  fetchAccountWithReference,
} from '../../../../graphql/v2/input/AccountReferenceInput';
import { GraphQLAccount } from '../../../../graphql/v2/interface/Account';
import { GraphQLAmount } from '../../../../graphql/v2/object/Amount';
import { Dimension, EnumValueDef, FilterValue, Measure, MetricRow } from '../../internal/types';

import {
  GraphQLMetricsAccountReferenceFilter,
  GraphQLMetricsIntFilter,
  GraphQLMetricsStringFilter,
} from './shared-types';

export type EnumDimensionTypes = { enumType: GraphQLEnumType; filterInput: GraphQLInputObjectType };

export function buildEnumDimensionTypes(name: string, values: ReadonlyArray<EnumValueDef>): EnumDimensionTypes {
  const enumType = new GraphQLEnumType({
    name,
    values: Object.fromEntries(values.map(v => [v.value, { value: v.value, description: v.description }])),
  });
  const filterInput = new GraphQLInputObjectType({
    name: `${name}Filter`,
    isOneOf: true,
    fields: () => ({
      eq: { type: enumType },
      in: { type: new GraphQLList(new GraphQLNonNull(enumType)) },
      isNull: { type: GraphQLBoolean },
    }),
  });
  return { enumType, filterInput };
}

function requireEnumTypes(d: Dimension, enumTypes?: Map<string, EnumDimensionTypes>): EnumDimensionTypes {
  const t = enumTypes?.get(d.name);
  if (!t) {
    throw new Error(`Missing GraphQL enum type for enumValues dimension '${d.name}'`);
  }
  return t;
}

export function measureGraphQLType(m: Measure): GraphQLOutputType {
  switch (m.kind) {
    case 'amount':
      return GraphQLAmount;
    case 'count':
      return GraphQLInt;
    case 'number':
      return GraphQLFloat;
    case 'date':
      return GraphQLDate;
    default:
      throw new Error(`Unknown measure kind: ${m['kind']}`);
  }
}

export function measureGraphQLResolver(
  m: Measure,
): (ctx: { row: MetricRow; measureName: string; isGroup: boolean }, value: unknown, req: Express.Request) => unknown {
  switch (m.kind) {
    case 'amount':
      return (ctx, value) => {
        return {
          value: value as number,
          currency: ctx.row.currency,
        };
      };
    case 'count':
    case 'number':
    case 'date':
      return (ctx, value) => value ?? null;
    default:
      throw new Error(`Unknown measure kind: ${m['kind']}`);
  }
}

export function dimensionGraphQLType(d: Dimension, enumTypes?: Map<string, EnumDimensionTypes>): GraphQLOutputType {
  switch (d.kind) {
    case 'int':
      return GraphQLInt;
    case 'string':
    case 'enum':
    case 'date':
      return GraphQLString;
    case 'enumValues':
      return requireEnumTypes(d, enumTypes).enumType;
    case 'boolean':
      return GraphQLBoolean;
    case 'account':
      return GraphQLAccount;
    default:
      throw new Error(`Unknown dimension kind: ${d['kind']}`);
  }
}

export function dimensionGraphQLResolver(
  d: Dimension,
): (ctx: { row: MetricRow; dimensionName: string; isGroup: boolean }, value: unknown, req: Express.Request) => unknown {
  switch (d.kind) {
    case 'int':
    case 'string':
    case 'enum':
    case 'enumValues':
    case 'date':
    case 'boolean':
      return (ctx, value) => {
        return value ?? null;
      };
    case 'account':
      return (ctx, value, req) => {
        if (value === null) {
          return null;
        }
        return req.loaders.Collective.byId.load(value as number);
      };
    default:
      throw new Error(`Unknown dimension kind: ${d['kind']}`);
  }
}

export function dimensionGraphQLInputType(d: Dimension, enumTypes?: Map<string, EnumDimensionTypes>): GraphQLInputType {
  switch (d.kind) {
    case 'int':
      return GraphQLMetricsIntFilter;
    case 'string':
    case 'enum':
    case 'date':
      return GraphQLMetricsStringFilter;
    case 'enumValues':
      return requireEnumTypes(d, enumTypes).filterInput;
    case 'boolean':
      return GraphQLBoolean;
    case 'account':
      return GraphQLMetricsAccountReferenceFilter;
    default:
      throw new Error(`Unknown dimension kind: ${d['kind']}`);
  }
}

export function dimensionGraphQLInputResolver(
  d: Dimension,
): (value: unknown, req: Express.Request) => Promise<FilterValue | undefined> | FilterValue | undefined {
  switch (d.kind) {
    case 'account': {
      return accountDimensionGraphQLInputResolver;
    }
    case 'boolean': {
      return booleanDimensionGraphQLInputResolver;
    }
    default:
      return scalarDimensionGraphQLInputResolver;
  }
}

function booleanDimensionGraphQLInputResolver(value: unknown): FilterValue {
  return value as FilterValue;
}

function scalarDimensionGraphQLInputResolver(value: {
  eq?: string | number;
  in?: Array<string | number>;
  isNull?: boolean;
}): FilterValue | undefined {
  if (value.eq !== undefined) {
    return value.eq as FilterValue;
  } else if (value.in?.length) {
    return value.in as FilterValue;
  } else if (value.isNull === true) {
    return null;
  } else if (value.isNull === false) {
    return undefined;
  }
  return undefined;
}

async function accountDimensionGraphQLInputResolver(
  value: { eq?: AccountReferenceInput; in?: AccountReferenceInput[]; isNull?: boolean },
  req: Express.Request,
): Promise<FilterValue | undefined> {
  if (value.eq) {
    const account = await fetchAccountWithReference(value.eq, { loaders: req.loaders, throwIfMissing: true });
    return account?.id ?? null;
  } else if (value.in?.length) {
    const ids = await fetchAccountsIdsWithReference(value.in, { loaders: req.loaders, throwIfMissing: true });
    return ids;
  } else if (value.isNull === true) {
    return null;
  } else if (value.isNull === false) {
    return undefined;
  }
  return undefined;
}
