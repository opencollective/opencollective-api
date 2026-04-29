import { type RawBuilder, sql } from 'kysely';

import {
  BUCKET_KEY,
  filterPredicates,
  groupKey,
  havingClause,
  joinAnd,
  joinComma,
  orderByClause,
  type QueryShape,
  renderAggregation,
  renderDimension,
  renderDirection,
  toIsoStringIfDate,
} from './builder-shared';
import type { MetricQuery, RangeRelationMetricSource, TimeUnit } from './types';

function bucketIntervalSql(unit: TimeUnit): RawBuilder<unknown> {
  switch (unit) {
    case 'day':
      return sql`INTERVAL '1 day'`;
    case 'week':
      return sql`INTERVAL '7 days'`;
    case 'month':
      return sql`INTERVAL '1 month'`;
    case 'quarter':
      return sql`INTERVAL '3 months'`;
    case 'year':
      return sql`INTERVAL '1 year'`;
  }
}

function rangeOverlapPredicate(
  s: RangeRelationMetricSource<any>,
  fromExpr: RawBuilder<unknown>,
  toExpr: RawBuilder<unknown>,
): RawBuilder<unknown> {
  const start = sql.id(s.startColumn);
  const end = sql.id(s.endColumn);
  return sql`${start} < ${toExpr} AND (${end} IS NULL OR ${end} >= ${fromExpr})`;
}

function rangeWhereBody<S extends RangeRelationMetricSource<any>>(q: MetricQuery<S>, s: S): RawBuilder<unknown> {
  const from = sql`${toIsoStringIfDate(q.dateFrom)}::timestamptz`;
  const to = sql`${toIsoStringIfDate(q.dateTo)}::timestamptz`;
  return joinAnd([rangeOverlapPredicate(s, from, to), ...filterPredicates(q)]);
}

function bucketSeriesSubquery<S extends RangeRelationMetricSource<any>>(
  q: MetricQuery<S>,
  unit: TimeUnit,
): RawBuilder<unknown> {
  const tz = q.timezone ?? 'UTC';
  const from = sql`${toIsoStringIfDate(q.dateFrom)}::timestamptz`;
  const to = sql`${toIsoStringIfDate(q.dateTo)}::timestamptz`;
  return sql`
    SELECT generate_series(
      DATE_TRUNC(${unit}, ${from} AT TIME ZONE ${tz}),
      DATE_TRUNC(${unit}, (${to} - INTERVAL '1 microsecond') AT TIME ZONE ${tz}),
      ${bucketIntervalSql(unit)}
    )::date AS ${sql.id(BUCKET_KEY)}
  `;
}

function rangeBucketJoinOn<S extends RangeRelationMetricSource<any>>(
  q: MetricQuery<S>,
  s: S,
  unit: TimeUnit,
): RawBuilder<unknown> {
  const bucketStart = sql`${sql.id('b')}.${sql.id(BUCKET_KEY)}::timestamptz`;
  const bucketEnd = sql`${sql.id('b')}.${sql.id(BUCKET_KEY)}::timestamptz + ${bucketIntervalSql(unit)}`;
  return joinAnd([rangeOverlapPredicate(s, bucketStart, bucketEnd), ...filterPredicates(q)]);
}

function rangeSelectColumns<S extends RangeRelationMetricSource<any>>(
  q: MetricQuery<S>,
  shape: QueryShape,
): RawBuilder<unknown> {
  const cols: RawBuilder<unknown>[] = [];
  if (q.bucket) {
    cols.push(sql`${sql.id('b')}.${sql.id(BUCKET_KEY)} AS ${sql.id(BUCKET_KEY)}`);
  }
  for (const dim of shape.groupByDims) {
    cols.push(sql`${renderDimension(dim)} AS ${sql.id(groupKey(dim.name))}`);
  }
  for (const m of shape.measures) {
    cols.push(sql`${renderAggregation(m)} AS ${sql.id(m.name)}`);
  }
  return joinComma(cols);
}

function rangeGroupByColumns<S extends RangeRelationMetricSource<any>>(
  q: MetricQuery<S>,
  shape: QueryShape,
): RawBuilder<unknown> {
  const cols: RawBuilder<unknown>[] = [];
  if (q.bucket) {
    cols.push(sql`${sql.id(BUCKET_KEY)}`);
  }
  for (const dim of shape.groupByDims) {
    cols.push(sql`${sql.id(groupKey(dim.name))}`);
  }
  return joinComma(cols);
}

function rangeOrderByClause<S extends RangeRelationMetricSource<any>>(
  q: MetricQuery<S>,
  shape: QueryShape,
): RawBuilder<unknown> {
  let fallback: RawBuilder<unknown>;
  if (q.bucket) {
    fallback = sql`ORDER BY ${sql.id(BUCKET_KEY)} ASC`;
  } else if (shape.measures.length > 0) {
    fallback = sql`ORDER BY ${renderAggregation(shape.measures[0])} DESC`;
  } else {
    fallback = sql``;
  }
  return orderByClause(q.source, q.orderBy, fallback);
}

function buildRangeBaseQuery<S extends RangeRelationMetricSource<any>>(
  q: MetricQuery<S>,
  s: S,
  shape: QueryShape,
): RawBuilder<Record<string, unknown>> {
  if (q.bucket) {
    const isTopNCase = !!(q.groupBy?.length && q.limit);
    if (isTopNCase) {
      throw new Error('buildRangeBaseQuery called for top-N case; use buildRangeTopNQuery');
    }
    const wantsGroupBy = q.bucket || shape.groupByDims.length;
    const groupBy = wantsGroupBy ? sql`GROUP BY ${rangeGroupByColumns(q, shape)}` : sql``;
    const having = havingClause(s, q.having);
    const limit = q.limit ? sql`LIMIT ${q.limit}` : sql``;

    return sql<Record<string, unknown>>`
      WITH ${sql.id('_buckets')} AS (${bucketSeriesSubquery(q, q.bucket)})
      SELECT ${rangeSelectColumns(q, shape)}
      FROM ${sql.id('_buckets')} AS ${sql.id('b')}
      LEFT JOIN ${sql.id(s.relation)} ON ${rangeBucketJoinOn(q, s, q.bucket)}
      ${groupBy}
      ${having}
      ${rangeOrderByClause(q, shape)}
      ${limit}
    `;
  }

  const wantsGroupBy = shape.groupByDims.length > 0;
  const groupBy = wantsGroupBy ? sql`GROUP BY ${rangeGroupByColumns(q, shape)}` : sql``;
  const having = havingClause(s, q.having);
  const limit = q.limit ? sql`LIMIT ${q.limit}` : sql``;

  return sql<Record<string, unknown>>`
    SELECT ${rangeSelectColumns(q, shape)}
    FROM ${sql.id(s.relation)}
    WHERE ${rangeWhereBody(q, s)}
    ${groupBy}
    ${having}
    ${rangeOrderByClause(q, shape)}
    ${limit}
  `;
}

function buildRangeTopNQuery(
  q: MetricQuery<RangeRelationMetricSource<any>>,
  s: RangeRelationMetricSource<any>,
  shape: QueryShape,
): RawBuilder<Record<string, unknown>> {
  if (!q.bucket || !q.groupBy?.length || !q.limit) {
    throw new Error('buildRangeTopNQuery called outside of bucket+groupBy+limit context');
  }

  const primaryOrder = q.orderBy?.[0];
  const orderMeasure = primaryOrder ? s.measures[primaryOrder.measure] : shape.measures[0];
  const orderDir = renderDirection(primaryOrder?.direction ?? 'desc');

  const groupExprs = shape.groupByDims.map(d => renderDimension(d));
  const groupSelect = shape.groupByDims.map(d => sql`${renderDimension(d)} AS ${sql.id(groupKey(d.name))}`);
  const groupKeys = shape.groupByDims.map(d => sql.id(groupKey(d.name)));

  const cteHaving = havingClause(s, q.having);
  const cte = sql`
    SELECT ${joinComma(groupSelect)}
    FROM ${sql.id(s.relation)}
    WHERE ${rangeWhereBody(q, s)}
    GROUP BY ${joinComma(groupExprs)}
    ${cteHaving}
    ORDER BY ${renderAggregation(orderMeasure)} ${orderDir}
    LIMIT ${q.limit}
  `;

  const dimTuple = sql`(${joinComma(groupExprs)})`;

  return sql<Record<string, unknown>>`
    WITH ${sql.id('_top_groups')} AS (${cte}),
         ${sql.id('_buckets')} AS (${bucketSeriesSubquery(q, q.bucket)})
    SELECT ${rangeSelectColumns(q, shape)}
    FROM ${sql.id('_buckets')} AS ${sql.id('b')}
    LEFT JOIN ${sql.id(s.relation)}
      ON ${rangeBucketJoinOn(q, s, q.bucket)}
      AND ${dimTuple} IN (SELECT ${joinComma(groupKeys)} FROM ${sql.id('_top_groups')})
    GROUP BY ${rangeGroupByColumns(q, shape)}
    ORDER BY ${sql.id(BUCKET_KEY)} ASC
  `;
}

export function buildRangeQuery(
  q: MetricQuery<RangeRelationMetricSource<any>>,
  shape: QueryShape,
): RawBuilder<Record<string, unknown>> {
  const useTopN = !!(q.bucket && q.groupBy?.length && q.limit);
  return useTopN ? buildRangeTopNQuery(q, q.source, shape) : buildRangeBaseQuery(q, q.source, shape);
}
