import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLTimeUnit } from '../../../../graphql/v2/enum/TimeUnit';
import { GraphQLAccountReferenceInput } from '../../../../graphql/v2/input/AccountReferenceInput';

export const METRICS_LIMIT_CAP = 1000;

export const GraphQLMetricsHavingOp = new GraphQLEnumType({
  name: 'MetricsHavingOp',
  description: 'Comparison operator for HAVING clauses on a measure.',
  values: {
    gt: { description: 'Greater than' },
    gte: { description: 'Greater than or equal' },
    lt: { description: 'Less than' },
    lte: { description: 'Less than or equal' },
    eq: { description: 'Equal' },
    ne: { description: 'Not equal' },
  },
});

export const GraphQLMetricsOrderByDirection = new GraphQLEnumType({
  name: 'MetricsOrderByDirection',
  values: {
    asc: { description: 'Ascending' },
    desc: { description: 'Descending' },
  },
});

export const GraphQLMetricsIntFilter = new GraphQLInputObjectType({
  name: 'MetricsIntFilter',
  isOneOf: true,
  fields: () => ({
    eq: { type: GraphQLInt },
    in: { type: new GraphQLList(new GraphQLNonNull(GraphQLInt)) },
    isNull: { type: GraphQLBoolean },
  }),
});

export const GraphQLMetricsStringFilter = new GraphQLInputObjectType({
  name: 'MetricsStringFilter',
  isOneOf: true,
  fields: () => ({
    eq: { type: GraphQLString },
    in: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    isNull: { type: GraphQLBoolean },
  }),
});

export const GraphQLMetricsAccountReferenceFilter = new GraphQLInputObjectType({
  name: 'MetricsAccountReferenceFilter',
  description: 'Filter a metric dimension that references an Account.',
  isOneOf: true,
  fields: () => ({
    eq: { type: GraphQLAccountReferenceInput },
    in: { type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)) },
    isNull: { type: GraphQLBoolean },
  }),
});

export const GraphQLMetricsDateRangeInput = new GraphQLInputObjectType({
  name: 'MetricsDateRangeInput',
  description: 'Date range `[from, to)`.',
  fields: () => ({
    from: { type: new GraphQLNonNull(GraphQLDateTime) },
    to: { type: new GraphQLNonNull(GraphQLDateTime) },
  }),
});

export const GraphQLMetricsResult = new GraphQLInterfaceType({
  name: 'MetricsResult',
  fields: () => ({
    dateFrom: { type: new GraphQLNonNull(GraphQLDateTime) },
    dateTo: { type: new GraphQLNonNull(GraphQLDateTime) },
    bucket: { type: GraphQLTimeUnit },
    groupBy: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
  }),
});

export const METRICS_RESULT_TYPE_KEY = '__metricsResultType';

export { GraphQLTimeUnit };
