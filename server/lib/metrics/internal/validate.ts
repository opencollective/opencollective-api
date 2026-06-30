import { isNil } from 'lodash';

import type { MetricQuery, MetricSource } from './types';

export class MetricsQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricsQueryError';
  }
}

const COMPLEXITY_LIMITS = {
  measures: 6,
  groupBy: 3,
  having: 2,
  orderBy: 2,
  filterInList: 100,
  buckets: 2000,
} as const;

const APPROX_DAYS_PER_BUCKET: Record<MetricQuery['bucket'] & string, number> = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 91,
  year: 365,
};

function validateComplexity<S extends MetricSource>(q: MetricQuery<S>): void {
  if (q.measures.length > COMPLEXITY_LIMITS.measures) {
    throw new MetricsQueryError(`Too many measures (${q.measures.length}); max is ${COMPLEXITY_LIMITS.measures}`);
  }
  if ((q.groupBy?.length ?? 0) > COMPLEXITY_LIMITS.groupBy) {
    throw new MetricsQueryError(
      `Too many groupBy dimensions (${q.groupBy?.length}); max is ${COMPLEXITY_LIMITS.groupBy}`,
    );
  }
  if ((q.having?.length ?? 0) > COMPLEXITY_LIMITS.having) {
    throw new MetricsQueryError(`Too many having predicates (${q.having?.length}); max is ${COMPLEXITY_LIMITS.having}`);
  }
  if ((q.orderBy?.length ?? 0) > COMPLEXITY_LIMITS.orderBy) {
    throw new MetricsQueryError(`Too many orderBy keys (${q.orderBy?.length}); max is ${COMPLEXITY_LIMITS.orderBy}`);
  }

  for (const [dim, value] of Object.entries(q.filters ?? {})) {
    if (Array.isArray(value) && value.length > COMPLEXITY_LIMITS.filterInList) {
      throw new MetricsQueryError(
        `Filter '${dim}' IN-list too large (${value.length}); max is ${COMPLEXITY_LIMITS.filterInList}`,
      );
    }
  }

  if (q.bucket) {
    const fromMs = new Date(q.dateFrom).getTime();
    const toMs = new Date(q.dateTo).getTime();
    if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
      const days = (toMs - fromMs) / (1000 * 60 * 60 * 24);
      const approxBuckets = Math.ceil(days / APPROX_DAYS_PER_BUCKET[q.bucket]);
      if (approxBuckets > COMPLEXITY_LIMITS.buckets) {
        throw new MetricsQueryError(
          `Date range too wide for bucket '${q.bucket}': would produce ~${approxBuckets} buckets, ` +
            `max is ${COMPLEXITY_LIMITS.buckets}. Narrow the range or coarsen the bucket.`,
        );
      }
    }
  }
}

export function validateQuery<S extends MetricSource>(q: MetricQuery<S>): void {
  const s = q.source;

  if (q.measures.length === 0) {
    throw new MetricsQueryError('At least one measure must be requested');
  }

  for (const m of q.measures) {
    if (!s.measures[m]) {
      throw new MetricsQueryError(`Unknown measure '${m}' on '${s.relation}'`);
    }
  }

  for (const dim of Object.keys(q.filters ?? {})) {
    if (!s.dimensions[dim]) {
      throw new MetricsQueryError(`Unknown filter dimension '${dim}' on '${s.relation}'`);
    }
  }

  for (const dim of q.groupBy ?? []) {
    if (!s.dimensions[dim]) {
      throw new MetricsQueryError(`Unknown groupBy dimension '${dim}' on '${s.relation}'`);
    }
  }

  for (const h of q.having ?? []) {
    if (!s.measures[h.measure]) {
      throw new MetricsQueryError(`Unknown having measure '${h.measure}'`);
    }
  }

  for (const o of q.orderBy ?? []) {
    if (!s.measures[o.measure]) {
      throw new MetricsQueryError(`Unknown orderBy measure '${o.measure}'`);
    }
  }

  if (q.groupBy?.length && !q.bucket && isNil(q.limit)) {
    throw new MetricsQueryError(`groupBy on '${s.relation}' requires an explicit limit when not bucketed`);
  }

  const amountMeasures = q.measures.map(m => s.measures[m]).filter(m => m.kind === 'amount');
  for (const m of amountMeasures) {
    if (!m.currencyColumn) {
      throw new MetricsQueryError(`Amount measure '${m.name}' on '${s.relation}' is missing currencyColumn`);
    }
  }
  const currencies = new Set(amountMeasures.map(m => m.currencyColumn));
  if (currencies.size > 1) {
    throw new MetricsQueryError(`Amount measures on '${s.relation}' have inconsistent currencyColumn`);
  }

  if (s.kind === 'range') {
    const invalid = q.measures.map(m => s.measures[m]).filter(m => m.kind === 'amount');
    if (invalid.length > 0) {
      throw new MetricsQueryError(`Range source '${s.relation}' doesn't support amount-kind measures`);
    }
  }

  validateComplexity(q);
}
