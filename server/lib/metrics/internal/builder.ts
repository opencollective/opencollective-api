import type { RawBuilder } from 'kysely';

import { buildDenseQuery } from './builder-relation-dense';
import { buildRangeQuery } from './builder-relation-range';
import { getQueryShape } from './builder-shared';
import type { DenseRelationMetricSource, MetricQuery, MetricSource, RangeRelationMetricSource } from './types';

export { BUCKET_KEY, CURRENCY_KEY, groupKey } from './builder-shared';

export function buildQuery<S extends MetricSource>(q: MetricQuery<S>): RawBuilder<Record<string, unknown>> {
  const shape = getQueryShape(q);

  if (q.source.kind === 'range') {
    return buildRangeQuery(q as unknown as MetricQuery<RangeRelationMetricSource<any>>, shape);
  }

  return buildDenseQuery(q as unknown as MetricQuery<DenseRelationMetricSource<any>>, shape);
}
