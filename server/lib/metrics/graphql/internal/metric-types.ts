import { GraphQLBoolean, GraphQLFloat, GraphQLInputType, GraphQLInt, GraphQLOutputType, GraphQLString } from 'graphql';

import {
  AccountReferenceInput,
  fetchAccountsIdsWithReference,
  fetchAccountWithReference,
} from '../../../../graphql/v2/input/AccountReferenceInput';
import { GraphQLAccount } from '../../../../graphql/v2/interface/Account';
import { GraphQLAmount } from '../../../../graphql/v2/object/Amount';
import { Dimension, FilterValue, Measure, MetricRow } from '../../internal/types';

import {
  GraphQLMetricsAccountReferenceFilter,
  GraphQLMetricsIntFilter,
  GraphQLMetricsStringFilter,
} from './shared-types';

export function measureGraphQLType(m: Measure): GraphQLOutputType {
  switch (m.kind) {
    case 'amount':
      return GraphQLAmount;
    case 'count':
      return GraphQLInt;
    case 'number':
      return GraphQLFloat;
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
      return (ctx, value) => value ?? null;
    default:
      throw new Error(`Unknown measure kind: ${m['kind']}`);
  }
}

export function dimensionGraphQLType(d: Dimension): GraphQLOutputType {
  switch (d.kind) {
    case 'int':
      return GraphQLInt;
    case 'string':
    case 'enum':
    case 'date':
      return GraphQLString;
    case 'boolean':
      return GraphQLBoolean;
    case 'account':
      return GraphQLAccount;
    default:
      throw new Error(`Unknown dimension kind: ${d.kind}`);
  }
}

export function dimensionGraphQLResolver(
  d: Dimension,
): (ctx: { row: MetricRow; dimensionName: string; isGroup: boolean }, value: unknown, req: Express.Request) => unknown {
  switch (d.kind) {
    case 'int':
    case 'string':
    case 'enum':
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
      throw new Error(`Unknown dimension kind: ${d.kind}`);
  }
}

export function dimensionGraphQLInputType(d: Dimension): GraphQLInputType {
  switch (d.kind) {
    case 'int':
      return GraphQLMetricsIntFilter;
    case 'string':
    case 'enum':
    case 'date':
      return GraphQLMetricsStringFilter;
    case 'boolean':
      return GraphQLBoolean;
    case 'account':
      return GraphQLMetricsAccountReferenceFilter;
    default:
      throw new Error(`Unknown dimension kind: ${d.kind}`);
  }
}

export function dimensionGraphQLInputResolver(
  d: Dimension,
): (value: unknown, req: Express.Request) => Promise<FilterValue> | FilterValue {
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
}): FilterValue {
  if (value.eq !== undefined) {
    return value.eq as FilterValue;
  } else if (value.in?.length) {
    return value.in as FilterValue;
  } else if (value.isNull === true) {
    return null;
  }
  throw new Error('Invalid scalar dimension value');
}

async function accountDimensionGraphQLInputResolver(
  value: { eq?: AccountReferenceInput; in?: AccountReferenceInput[]; isNull?: boolean },
  req: Express.Request,
): Promise<FilterValue> {
  if (value.eq) {
    const account = await fetchAccountWithReference(value.eq, { loaders: req.loaders, throwIfMissing: true });
    return account?.id ?? null;
  } else if (value.in?.length) {
    const ids = await fetchAccountsIdsWithReference(value.in, { loaders: req.loaders, throwIfMissing: true });
    return ids;
  } else if (value.isNull === true) {
    return null;
  }
  throw new Error('Invalid account dimension value');
}
