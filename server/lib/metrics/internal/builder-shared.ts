import { type Expression, expressionBuilder, type RawBuilder, sql } from 'kysely';

import { DatabaseWithViews } from '../../kysely';

import type {
  Dimension,
  FilterValue,
  Having,
  HavingOp,
  Measure,
  MeasureKey,
  MetricQuery,
  MetricSource,
  SqlExpressionFn,
} from './types';

export const BUCKET_KEY = '_bucket';
export const CURRENCY_KEY = '_currency';
export const groupKey = (dimensionName: string) => `_g_${dimensionName}`;

export type QueryShape = {
  measures: Measure[];
  groupByDims: Dimension[];
  currencyColumn: string | null;
};

export function getQueryShape<S extends MetricSource>(q: MetricQuery<S>): QueryShape {
  const s = q.source;
  const measures = q.measures.map(m => s.measures[m]);
  const groupByDims = (q.groupBy ?? []).map(d => s.dimensions[d]);
  const amountMeasure = measures.find(m => m.kind === 'amount');

  return {
    measures,
    groupByDims,
    currencyColumn: amountMeasure?.currencyColumn ?? null,
  };
}

function renderExpression(fn: SqlExpressionFn<keyof DatabaseWithViews>): Expression<unknown> {
  return fn(expressionBuilder());
}

export function renderDimension(dim: Dimension): Expression<unknown> {
  if ('column' in dim) {
    return dim.kind === 'enum' ? sql`${sql.id(dim.column)}::text` : sql`${sql.id(dim.column)}`;
  }
  return renderExpression(dim.expression);
}

export function renderAggregation(m: Measure): Expression<unknown> {
  return renderExpression(m.aggregation);
}

export function renderDirection(d: 'asc' | 'desc'): RawBuilder<unknown> {
  return d === 'asc' ? sql`ASC` : sql`DESC`;
}

type SqlPart = Expression<unknown> | RawBuilder<unknown>;

export const joinComma = (parts: SqlPart[]): RawBuilder<unknown> => {
  if (parts.length === 0) {
    return sql``;
  }
  return parts.reduce<RawBuilder<unknown>>((acc, p, i) => (i === 0 ? sql`${p}` : sql`${acc}, ${p}`), sql``);
};

export const joinAnd = (parts: SqlPart[]): RawBuilder<unknown> => {
  if (parts.length === 0) {
    return sql`TRUE`;
  }
  return parts.reduce<RawBuilder<unknown>>((acc, p, i) => (i === 0 ? sql`${p}` : sql`${acc} AND ${p}`), sql``);
};

export const toIsoStringIfDate = (d: Date | string): string => (typeof d === 'string' ? d : d.toISOString());

function filterPredicate(dim: Dimension, value: FilterValue): RawBuilder<unknown> {
  const expr = renderDimension(dim);
  if (value === null) {
    return sql`${expr} IS NULL`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return sql`FALSE`;
    }
    return sql`${expr} = ANY(${value})`;
  }
  if (typeof value === 'boolean') {
    return value ? sql`${expr} IS TRUE` : sql`${expr} IS FALSE`;
  }
  return sql`${expr} = ${value}`;
}

export function filterPredicates<S extends MetricSource>(q: MetricQuery<S>): RawBuilder<unknown>[] {
  const parts: RawBuilder<unknown>[] = [];
  for (const [name, value] of Object.entries(q.filters ?? {})) {
    if (value === undefined) {
      continue;
    }
    parts.push(filterPredicate(q.source.dimensions[name], value as FilterValue));
  }
  return parts;
}

const HAVING_SQL_OP: Record<HavingOp, string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '=',
  ne: '<>',
};

export const havingClause = <S extends MetricSource>(
  s: S,
  having: ReadonlyArray<Having<S>> | undefined,
): RawBuilder<unknown> => {
  if (!having?.length) {
    return sql``;
  }
  const parts = having.map(h => {
    const m = s.measures[h.measure];
    return sql`${renderAggregation(m)} ${sql.raw(HAVING_SQL_OP[h.op])} ${h.value}`;
  });
  return sql`HAVING ${joinAnd(parts)}`;
};

export function orderByClause<S extends MetricSource>(
  s: S,
  orderBy: ReadonlyArray<{ measure: MeasureKey<S>; direction: 'asc' | 'desc' }> | undefined,
  fallback: RawBuilder<unknown>,
): RawBuilder<unknown> {
  if (!orderBy?.length) {
    return fallback;
  }
  const parts = orderBy.map(o => {
    const m = s.measures[o.measure];
    return sql`${renderAggregation(m)} ${renderDirection(o.direction)}`;
  });
  return sql`ORDER BY ${joinComma(parts)}`;
}
