import {
  GraphQLEnumType,
  type GraphQLFieldConfig,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { queryMetrics } from '../..';
import type {
  Dimension,
  Filters,
  FilterValue,
  Measure,
  MetricQuery,
  MetricRow,
  MetricSource,
  TimeUnit,
} from '../../internal/types';
import { gqlNameForDimension, graphqlNameToDimName } from '../utils';

import {
  dimensionGraphQLInputResolver,
  dimensionGraphQLInputType,
  dimensionGraphQLResolver,
  dimensionGraphQLType,
  measureGraphQLResolver,
  measureGraphQLType,
} from './metric-types';
import {
  GraphQLMetricsDateRangeInput,
  GraphQLMetricsHavingOp,
  GraphQLMetricsOrderByDirection,
  GraphQLMetricsResult,
  GraphQLTimeUnit,
  METRICS_LIMIT_CAP,
  METRICS_RESULT_TYPE_KEY,
} from './shared-types';

type ParentBinding<P> = (parent: P) => number | number[];

type SourceFieldOptions<P> = {
  source: MetricSource;
  /** Type-name prefix for the generated GraphQL types (e.g., `'HostedCollectivesFinancialActivity'`). */
  schemaPrefix: string;
  description?: string;
  /**
   * Dimensions whose value is bound from the parent (e.g., `hostCollectiveId`
   * on `Host.metrics`). Bound dimensions are omitted from the generated input
   * filters, dimension enum, and group output.
   */
  bindFromParent?: Record<string, ParentBinding<P>>;
};

export function buildSourceField<P>(options: SourceFieldOptions<P>): GraphQLFieldConfig<P, unknown> {
  const { source, schemaPrefix, description, bindFromParent = {} } = options;

  // dimensions that are not exposed as input, passed from resolver
  const boundDimNames = new Set(Object.keys(bindFromParent));
  // dimensions that are exposed as input
  const exposedDims = Object.values(source.dimensions).filter(d => !boundDimNames.has(d.name));
  const measures = Object.values(source.measures);

  const measureEnum = buildMeasureEnum(schemaPrefix, measures);
  const dimensionEnum = buildDimensionEnum(schemaPrefix, exposedDims);

  const filtersInput = buildFiltersInput(schemaPrefix, exposedDims);
  const havingInput = buildHavingInput(schemaPrefix, measureEnum);
  const orderByInput = buildOrderByInput(schemaPrefix, measureEnum);
  const mainInput = buildMainInput(schemaPrefix, measureEnum, dimensionEnum, filtersInput, havingInput, orderByInput);

  const groupType = buildGroupType(schemaPrefix, exposedDims);
  const valuesType = buildValuesType(schemaPrefix, measures);
  const rowType = buildRowType(schemaPrefix, groupType, valuesType);
  const resultTypeName = `${schemaPrefix}MetricsResult`;
  const resultType = buildResultType(schemaPrefix, resultTypeName, rowType);

  return {
    type: new GraphQLNonNull(resultType),
    description,
    args: {
      input: { type: new GraphQLNonNull(mainInput) },
    },
    resolve: async (parent, args: { input: MetricInputArgs }, req: Express.Request) => {
      const input = args.input;
      const filters = await resolveInputFilters(input.filters ?? {}, source, req);
      for (const [dimName, getter] of Object.entries(bindFromParent)) {
        filters[dimName] = getter(parent) as FilterValue;
      }
      const groupBy = (input.groupBy ?? []).map(g => graphqlNameToDimName(source, g));
      const limit = input.limit !== null ? Math.min(input.limit, METRICS_LIMIT_CAP) : undefined;
      const bucket = input.bucket ? (input.bucket.toLowerCase() as TimeUnit) : undefined;

      const query: MetricQuery = {
        source,
        measures: input.measures,
        dateFrom: input.dateRange.from,
        dateTo: input.dateRange.to,
        filters,
        bucket,
        groupBy: groupBy.length ? groupBy : undefined,
        having: input.having,
        orderBy: input.orderBy,
        limit,
        timezone: input.timezone,
      };
      const result = await queryMetrics(query);
      return { ...result, [METRICS_RESULT_TYPE_KEY]: resultTypeName };
    },
  };
}

function buildMeasureEnum(prefix: string, measures: Measure[]): GraphQLEnumType {
  return new GraphQLEnumType({
    name: `${prefix}MetricsMeasure`,
    values: Object.fromEntries(measures.map(m => [m.name, { description: m.description }])),
  });
}

function buildDimensionEnum(prefix: string, dims: Dimension[]): GraphQLEnumType {
  return new GraphQLEnumType({
    name: `${prefix}MetricsDimension`,
    values: Object.fromEntries(dims.map(d => [gqlNameForDimension(d), {}])),
  });
}

function buildFiltersInput(prefix: string, dims: Dimension[]): GraphQLInputObjectType {
  // Name reserves room for a future recursive `${prefix}MetricsFilter` (a boolean
  // tree of leaves) — today's input is strictly an AND of per-dimension leaves.
  return new GraphQLInputObjectType({
    name: `${prefix}MetricsFiltersAllOf`,
    fields: () => Object.fromEntries(dims.map(d => [gqlNameForDimension(d), { type: dimensionGraphQLInputType(d) }])),
  });
}

function buildHavingInput(prefix: string, measureEnum: GraphQLEnumType): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: `${prefix}MetricsHavingInput`,
    fields: () => ({
      measure: { type: new GraphQLNonNull(measureEnum) },
      op: { type: new GraphQLNonNull(GraphQLMetricsHavingOp) },
      value: { type: new GraphQLNonNull(GraphQLFloat) },
    }),
  });
}

function buildOrderByInput(prefix: string, measureEnum: GraphQLEnumType): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: `${prefix}MetricsOrderByInput`,
    fields: () => ({
      measure: { type: new GraphQLNonNull(measureEnum) },
      direction: { type: new GraphQLNonNull(GraphQLMetricsOrderByDirection) },
    }),
  });
}

function buildMainInput(
  prefix: string,
  measureEnum: GraphQLEnumType,
  dimensionEnum: GraphQLEnumType,
  filtersInput: GraphQLInputObjectType,
  havingInput: GraphQLInputObjectType,
  orderByInput: GraphQLInputObjectType,
): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: `${prefix}MetricsInput`,
    fields: () => ({
      dateRange: { type: new GraphQLNonNull(GraphQLMetricsDateRangeInput) },
      measures: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(measureEnum))),
      },
      filters: { type: filtersInput },
      bucket: {
        type: GraphQLTimeUnit,
        description: 'Time grain. Omit for a single aggregate over the whole range.',
      },
      groupBy: { type: new GraphQLList(new GraphQLNonNull(dimensionEnum)) },
      having: { type: new GraphQLList(new GraphQLNonNull(havingInput)) },
      orderBy: { type: new GraphQLList(new GraphQLNonNull(orderByInput)) },
      limit: {
        type: GraphQLInt,
      },
      timezone: {
        type: GraphQLString,
        defaultValue: 'UTC',
        description:
          'IANA timezone applied to `DATE_TRUNC` when bucketing — determines where each month/week/day boundary falls. ' +
          'Independent of `dateRange` (which already carries the absolute window via ISO offsets): two queries with the same ' +
          'dateRange but different timezones can produce different bucket boundaries.',
      },
    }),
  });
}

type MetricRowShape = {
  bucket?: string;
  group?: Record<string, unknown>;
  values: Record<string, number>;
  currency?: string;
};

function buildGroupType(prefix: string, dims: Dimension[]): GraphQLObjectType {
  return new GraphQLObjectType({
    name: `${prefix}MetricsGroup`,
    fields: () =>
      Object.fromEntries(
        dims.map(d => {
          const gqlType = dimensionGraphQLType(d);
          const gqlResolver = dimensionGraphQLResolver(d);

          const gqlName = gqlNameForDimension(d);

          return [
            gqlName,
            {
              type: gqlType,
              resolve: (row: MetricRow, args, req: Express.Request) =>
                gqlResolver({ row, dimensionName: d.name, isGroup: true }, row.group?.[d.name], req),
            },
          ];
        }),
      ),
  });
}

function buildValuesType(prefix: string, measures: Measure[]): GraphQLObjectType {
  return new GraphQLObjectType({
    name: `${prefix}MetricsValues`,
    fields: () =>
      Object.fromEntries(
        measures.map(m => {
          const gqlType = measureGraphQLType(m);
          const gqlResolver = measureGraphQLResolver(m);

          return [
            m.name,
            {
              type: gqlType,
              description: m.description,
              resolve: (row: MetricRow, args, req: Express.Request) =>
                gqlResolver({ row, measureName: m.name, isGroup: false }, row.values[m.name], req),
            },
          ];
        }),
      ),
  });
}

function buildRowType(prefix: string, groupType: GraphQLObjectType, valuesType: GraphQLObjectType): GraphQLObjectType {
  return new GraphQLObjectType({
    name: `${prefix}MetricsRow`,
    fields: () => ({
      bucket: { type: GraphQLString, resolve: (row: MetricRowShape) => row.bucket ?? null },
      group: {
        type: groupType,
        resolve: (row: MetricRowShape) => (row.group ? row : null),
      },
      values: { type: new GraphQLNonNull(valuesType), resolve: (row: MetricRowShape) => row },
    }),
  });
}

function buildResultType(prefix: string, resultTypeName: string, rowType: GraphQLObjectType): GraphQLObjectType {
  return new GraphQLObjectType({
    name: `${prefix}MetricsResult`,
    interfaces: [GraphQLMetricsResult],
    isTypeOf: (value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      (value as Record<string, unknown>)[METRICS_RESULT_TYPE_KEY] === resultTypeName,
    fields: () => ({
      dateFrom: { type: new GraphQLNonNull(GraphQLDateTime) },
      dateTo: { type: new GraphQLNonNull(GraphQLDateTime) },
      bucket: {
        type: GraphQLTimeUnit,
        resolve: (r: { bucket?: string }) => (r.bucket ? r.bucket.toUpperCase() : null),
      },
      groupBy: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
      rows: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(rowType))) },
    }),
  });
}

type MetricInputArgs = {
  dateRange: { from: Date | string; to: Date | string };
  measures: string[];
  filters?: Record<string, unknown>;
  bucket?: string;
  groupBy?: string[];
  having?: Array<{ measure: string; op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne'; value: number }>;
  orderBy?: Array<{ measure: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  timezone?: string;
};

async function resolveInputFilters(
  graphqlFilters: Record<string, unknown>,
  source: MetricSource,
  req: Express.Request,
): Promise<Filters> {
  const out: Filters = {};
  for (const dim of Object.values(source.dimensions)) {
    const gqlName = gqlNameForDimension(dim);
    const value = graphqlFilters[gqlName];
    if (value === undefined || value === null) {
      continue;
    }

    const resolver = dimensionGraphQLInputResolver(dim);
    out[dim.name] = await resolver(value, req);
  }
  return out;
}
