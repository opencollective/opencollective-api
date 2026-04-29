import type { Expression, ExpressionBuilder } from 'kysely';

import type { DatabaseWithViews } from '../../kysely';

type ColumnOf<Row> = keyof Row & string;

type DimensionKind = 'int' | 'string' | 'boolean' | 'enum' | 'date' | 'account';

export type SqlExpressionFn<R extends keyof DatabaseWithViews> = (
  eb: ExpressionBuilder<DatabaseWithViews, R>,
) => Expression<unknown>;
export type Dimension = RelationDimension<any>;
export type Measure = RelationMeasure<any>;

type RelationDimension<R extends keyof DatabaseWithViews, Row = DatabaseWithViews[R]> =
  | {
      name: string;
      kind: DimensionKind;
      column: ColumnOf<Row>;
      nullable?: boolean;
    }
  | {
      name: string;
      kind: DimensionKind;
      expression: SqlExpressionFn<R>;
      nullable?: boolean;
    };

type RelationMeasure<R extends keyof DatabaseWithViews, Row = DatabaseWithViews[R]> =
  | {
      name: string;
      aggregation: SqlExpressionFn<R>;
      kind: 'count' | 'number';
      description?: string;
    }
  | {
      name: string;
      aggregation: SqlExpressionFn<R>;
      kind: 'amount';
      currencyColumn: ColumnOf<Row>;
      description?: string;
    };

export type DenseRelationMetricSource<R extends keyof DatabaseWithViews, Row = DatabaseWithViews[R]> = {
  kind: 'dense';
  relation: string;
  /** Column used for date-range filtering and bucketing. Must be `date` or `timestamptz`. */
  dateColumn: ColumnOf<Row>;
  dimensions: Record<string, RelationDimension<R>>;
  measures: Record<string, RelationMeasure<R>>;
};

export type RangeRelationMetricSource<R extends keyof DatabaseWithViews, Row = DatabaseWithViews[R]> = {
  kind: 'range';
  relation: string;
  startColumn: ColumnOf<Row>;
  endColumn: ColumnOf<Row>;
  dimensions: Record<string, RelationDimension<R>>;
  measures: Record<string, RelationMeasure<R>>;
};

export type MetricSource = RelationMetricSource<never>;
type RelationMetricSource<R extends keyof DatabaseWithViews> =
  | DenseRelationMetricSource<R>
  | RangeRelationMetricSource<R>;

/**
 * Define a metric source backed by a single Postgres relation (table, view, or
 * materialized view). The `relation` name is a Kysely-typed key — it's the
 * internal identity of the source and is never exposed through GraphQL.
 *
 */
export function defineRelationMetricSource<
  R extends keyof DatabaseWithViews,
  const Def extends Omit<DenseRelationMetricSource<R>, 'relation'> | Omit<RangeRelationMetricSource<R>, 'relation'>,
>(relation: R, def: Def): { relation: R } & Def {
  return { relation, ...def };
}

export type MeasureKey<S extends MetricSource> = keyof S['measures'] & string;
type DimensionKey<S extends MetricSource> = keyof S['dimensions'] & string;

export type FilterValue = string | number | boolean | null | Array<string | number>;

export type Filters<S extends MetricSource = MetricSource> = Partial<Record<DimensionKey<S>, FilterValue>>;

export type TimeUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

export type HavingOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne';

export type Having<S extends MetricSource = MetricSource> = {
  measure: MeasureKey<S>;
  op: HavingOp;
  value: number;
};

type OrderBy<S extends MetricSource = MetricSource> = {
  measure: MeasureKey<S>;
  direction: 'asc' | 'desc';
};

export type MetricQuery<S extends MetricSource = MetricSource> = {
  source: S;
  /** Subset of `source.measures` keys to compute. Required, non-empty. */
  measures: ReadonlyArray<MeasureKey<S>>;
  /** Half-open range `[from, to)`. ISO string or Date. */
  dateFrom: Date | string;
  dateTo: Date | string;
  /** Equality, IN-list, IS NULL (`null`), or boolean. Keys must be in `source.dimensions`. */
  filters?: Filters<S>;
  /** Time grain. Omit for a single aggregate over the whole range. */
  bucket?: TimeUnit;
  /** Additional non-time grouping. Each entry is a key from `source.dimensions`. */
  groupBy?: ReadonlyArray<DimensionKey<S>>;
  /**
   * HAVING-style post-aggregate predicates on measures (e.g. spendingAmount > 0).
   * Multiple entries are AND-combined.
   */
  having?: ReadonlyArray<Having<S>>;
  /**
   * Sort order. Multiple entries become a comma-separated `ORDER BY` (the first
   * is primary, the rest are tiebreakers). For top-N (`bucket + groupBy + limit`)
   * only the first entry drives group selection.
   *
   * Default when omitted: bucket ASC when bucketed, otherwise the first measure DESC.
   */
  orderBy?: ReadonlyArray<OrderBy<S>>;
  /**
   * Top-N selection on the `groupBy` axis.
   *
   * `limit` always counts GROUPS (not raw rows). Combined with:
   *   - `groupBy` only:               plain `ORDER BY ... LIMIT N`
   *   - `groupBy` + `bucket`:         CTE picks top-N groups by `orderBy.measure`
   *                                   totalled over the full date range, then the
   *                                   main query returns the bucketed series
   *                                   restricted to those group keys. One round-trip.
   *   - no `groupBy`:                 row limit on the (possibly bucketed) result.
   */
  limit?: number;
  /** Timezone passed to DATE_TRUNC for bucketing. Default: 'UTC'. */
  timezone?: string;
};

export type MetricRow<M extends string = string> = {
  /** ISO date — start of the bucket. Present iff the query has `bucket`. */
  bucket?: string;
  /** Group dimension values. Present iff the query has `groupBy`. */
  group?: Record<string, string | number | boolean | null>;
  /** All requested measures, keyed by name. */
  values: Record<M, number>;
  /** Currency code when at least one queried measure is `kind: 'amount'`. */
  currency?: string;
};

export type MetricResult<M extends string = string> = {
  source: string;
  measures: readonly M[];
  dateFrom: string;
  dateTo: string;
  bucket?: TimeUnit;
  groupBy?: string[];
  rows: MetricRow<M>[];
};
