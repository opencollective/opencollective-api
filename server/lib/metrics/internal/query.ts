import { getKysely } from '../../kysely';

import { buildQuery } from './builder';
import { parseRows } from './parser';
import type { Filters, MeasureKey, MetricQuery, MetricResult, MetricSource } from './types';
import { MetricsQueryError, validateQuery } from './validate';

export async function queryMetrics<S extends MetricSource, const M extends MeasureKey<S>>(
  query: MetricQuery<S>,
): Promise<MetricResult<M>> {
  validateQuery(query);
  const compiled = buildQuery(query);
  const result = await compiled.execute(getKysely());
  return parseRows(query, result.rows) as MetricResult<M>;
}

const LIST_MATCHING_DIMENSION_VALUES_CAP = 100_000;

type ListMatchingDimensionValuesOptions<S extends MetricSource> = {
  source: S;
  /** Range `[from, to)`. ISO string or Date. */
  dateFrom: Date | string;
  dateTo: Date | string;
  filters?: Filters<S>;
  dimension: keyof S['dimensions'] & string;
};

/**
 * List the distinct values of one dimension that match a date range + filters.
 *
 */
export async function listMatchingDimensionValues<S extends MetricSource>(
  opts: ListMatchingDimensionValuesOptions<S>,
): Promise<Array<string | number>> {
  const measureNames = Object.keys(opts.source.measures);
  if (measureNames.length === 0) {
    throw new MetricsQueryError(`Source '${opts.source.relation}' has no measures — cannot list dimension values`);
  }

  const result = await queryMetrics({
    source: opts.source,
    measures: [measureNames[0]] as never,
    dateFrom: opts.dateFrom,
    dateTo: opts.dateTo,
    filters: opts.filters,
    groupBy: [opts.dimension] as never,
    limit: LIST_MATCHING_DIMENSION_VALUES_CAP,
  });

  const out: Array<string | number> = [];
  for (const row of result.rows) {
    const value = row.group?.[opts.dimension];
    if (value !== null && value !== undefined) {
      out.push(value as string | number);
    }
  }
  return out;
}
