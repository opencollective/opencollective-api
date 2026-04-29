import { type RawBuilder, sql } from 'kysely';

import {
  BUCKET_KEY,
  CURRENCY_KEY,
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
import type { DenseRelationMetricSource, MetricQuery, TimeUnit } from './types';

function denseBucketSql(dateColumn: string, unit: TimeUnit, tz: string): RawBuilder<string> {
  return sql<string>`DATE_TRUNC(${unit}, ${sql.id(dateColumn)} AT TIME ZONE ${tz})::date`;
}

function denseWhereBody<S extends DenseRelationMetricSource<any>>(q: MetricQuery<S>, s: S): RawBuilder<unknown> {
  const date = sql.id(s.dateColumn);
  const parts: RawBuilder<unknown>[] = [
    sql`${date} >= ${toIsoStringIfDate(q.dateFrom)}`,
    sql`${date} < ${toIsoStringIfDate(q.dateTo)}`,
    ...filterPredicates(q),
  ];
  return joinAnd(parts);
}

function denseSelectColumns<S extends DenseRelationMetricSource<any>>(
  q: MetricQuery<S>,
  s: S,
  shape: QueryShape,
): RawBuilder<unknown> {
  const tz = q.timezone ?? 'UTC';
  const cols: RawBuilder<unknown>[] = [];
  if (q.bucket) {
    cols.push(sql`${denseBucketSql(s.dateColumn, q.bucket, tz)} AS ${sql.id(BUCKET_KEY)}`);
  }
  for (const dim of shape.groupByDims) {
    cols.push(sql`${renderDimension(dim)} AS ${sql.id(groupKey(dim.name))}`);
  }
  if (shape.currencyColumn) {
    cols.push(sql`${sql.id(shape.currencyColumn)} AS ${sql.id(CURRENCY_KEY)}`);
  }
  for (const m of shape.measures) {
    cols.push(sql`${renderAggregation(m)} AS ${sql.id(m.name)}`);
  }
  return joinComma(cols);
}

function denseGroupByColumns<S extends DenseRelationMetricSource<any>>(
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
  if (shape.currencyColumn) {
    cols.push(sql`${sql.id(CURRENCY_KEY)}`);
  }
  return joinComma(cols);
}

function denseOrderByClause<S extends DenseRelationMetricSource<any>>(
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

function buildDenseBaseQuery<S extends DenseRelationMetricSource<any>>(
  q: MetricQuery<S>,
  s: S,
  shape: QueryShape,
): RawBuilder<Record<string, unknown>> {
  const wantsGroupBy = !!(q.bucket || shape.groupByDims.length || shape.currencyColumn);
  const groupBy = wantsGroupBy ? sql`GROUP BY ${denseGroupByColumns(q, shape)}` : sql``;
  const having = havingClause(s, q.having);
  const isTopNCase = !!(q.bucket && shape.groupByDims.length && q.limit);
  const limit = q.limit && !isTopNCase ? sql`LIMIT ${q.limit}` : sql``;

  return sql<Record<string, unknown>>`
    SELECT ${denseSelectColumns(q, s, shape)}
    FROM ${sql.id(s.relation)}
    WHERE ${denseWhereBody(q, s)}
    ${groupBy}
    ${having}
    ${denseOrderByClause(q, shape)}
    ${limit}
  `;
}

function buildDenseTopNQuery<S extends DenseRelationMetricSource<any>>(
  q: MetricQuery<S>,
  s: S,
  shape: QueryShape,
): RawBuilder<Record<string, unknown>> {
  if (!q.bucket || !q.groupBy?.length || !q.limit) {
    throw new Error('buildDenseTopNQuery called outside of bucket+groupBy+limit context');
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
    WHERE ${denseWhereBody(q, s)}
    GROUP BY ${joinComma(groupExprs)}
    ${cteHaving}
    ORDER BY ${renderAggregation(orderMeasure)} ${orderDir}
    LIMIT ${q.limit}
  `;

  const dimTuple = sql`(${joinComma(groupExprs)})`;
  const cteName = sql.id('_top_groups');

  return sql<Record<string, unknown>>`
    WITH ${cteName} AS (${cte})
    SELECT ${denseSelectColumns(q, s, shape)}
    FROM ${sql.id(s.relation)}
    WHERE ${denseWhereBody(q, s)}
      AND ${dimTuple} IN (SELECT ${joinComma(groupKeys)} FROM ${cteName})
    GROUP BY ${denseGroupByColumns(q, shape)}
    ORDER BY ${sql.id(BUCKET_KEY)} ASC
  `;
}

export function buildDenseQuery<S extends DenseRelationMetricSource<any>>(
  q: MetricQuery<S>,
  shape: QueryShape,
): RawBuilder<Record<string, unknown>> {
  const useTopN = !!(q.bucket && q.groupBy?.length && q.limit);
  return useTopN ? buildDenseTopNQuery(q, q.source, shape) : buildDenseBaseQuery(q, q.source, shape);
}
