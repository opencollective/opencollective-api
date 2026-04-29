import { isNil } from 'lodash';

import { BUCKET_KEY, CURRENCY_KEY, groupKey } from './builder';
import type { MeasureKey, MetricQuery, MetricResult, MetricRow, MetricSource } from './types';

function toIsoString(d: Date | string): string {
  if (typeof d === 'string') {
    return d;
  }
  return d.toISOString();
}

function toIsoDate(v: unknown): string {
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  return String(v);
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') {
    return v;
  }
  if (isNil(v)) {
    return 0;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function parseRows<S extends MetricSource, const M extends MeasureKey<S>>(
  q: MetricQuery<S>,
  dbRows: Record<string, unknown>[],
): MetricResult {
  const groupNames = (q.groupBy ?? []).map(g => q.source.dimensions[g].name);

  const rows: MetricRow<M>[] = dbRows.map(r => {
    const row: MetricRow = { values: {} };

    if (!isNil(r[BUCKET_KEY])) {
      row.bucket = toIsoDate(r[BUCKET_KEY]);
    }

    if (groupNames.length > 0) {
      row.group = {};
      for (const name of groupNames) {
        row.group[name] = r[groupKey(name)] as string | number | boolean | null;
      }
    }

    if (!isNil(r[CURRENCY_KEY])) {
      row.currency = String(r[CURRENCY_KEY]);
    }

    for (const m of q.measures) {
      row.values[m] = toNumber(r[m]);
    }

    return row;
  });

  return {
    source: q.source.relation,
    measures: [...q.measures],
    dateFrom: toIsoString(q.dateFrom),
    dateTo: toIsoString(q.dateTo),
    bucket: q.bucket,
    groupBy: q.groupBy ? [...q.groupBy] : undefined,
    rows,
  };
}
