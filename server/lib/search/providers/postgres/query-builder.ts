/**
 * Builds the single statement that returns, for one entity request, the exact total, the offset-independent
 * maximum score and the requested page. Being a single statement, all three come from the same snapshot.
 *
 *   WITH arms AS (<arm 1> UNION ALL <arm 2> ...),
 *        best AS MATERIALIZED (SELECT id, max(score) AS score FROM arms GROUP BY id),
 *        agg AS (SELECT count(*) AS total, coalesce(max(score), 0) AS "maxScore" FROM best)
 *   SELECT agg.total, agg."maxScore", page.id, page.score
 *   FROM agg LEFT JOIN LATERAL (SELECT ... FROM best ORDER BY score DESC, id DESC LIMIT $l OFFSET $o) page ON TRUE
 *
 * An empty later page still returns the `agg` row (with a NULL page), so totals and maxScore are always exact.
 */

import { Kysely, sql } from 'kysely';

import type { DatabaseWithViews } from '../../../kysely';
import type { SearchEntityResult } from '../../types';

import type { SearchArm } from './adapters/types';

type RankedRow = { total: number; maxScore: number; id: number | null; score: number | null };

export const executeRankedSearchQuery = async (
  db: Kysely<DatabaseWithViews>,
  arms: SearchArm[],
  { limit, offset }: { limit: number; offset: number },
): Promise<SearchEntityResult> => {
  if (!arms.length) {
    return { totalCount: 0, maxScore: 0, hits: [] };
  }

  const union = arms.slice(1).reduce((query, arm) => query.unionAll(arm), arms[0]);
  const rows = (await db
    .with('arms', () => union)
    .with(
      wb => wb('best').materialized(),
      qb =>
        qb
          .selectFrom('arms')
          .select(['arms.id', sql<number>`max(arms.score)`.as('score')])
          .groupBy('arms.id'),
    )
    .with('agg', qb =>
      qb
        .selectFrom('best')
        .select([sql<number>`count(*)::int`.as('total'), sql<number>`coalesce(max(best.score), 0)`.as('maxScore')]),
    )
    .selectFrom('agg')
    .leftJoinLateral(
      eb =>
        eb
          .selectFrom('best')
          .select(['best.id', 'best.score'])
          .orderBy('best.score', 'desc')
          .orderBy('best.id', 'desc')
          .limit(limit)
          .offset(offset)
          .as('page'),
      join => join.onTrue(),
    )
    .select(['agg.total', 'agg.maxScore', 'page.id', 'page.score'])
    .execute()) as RankedRow[];

  return {
    totalCount: Number(rows[0]?.total ?? 0),
    maxScore: Number(rows[0]?.maxScore ?? 0),
    hits: rows.filter(row => row.id !== null).map(row => ({ id: Number(row.id), score: Number(row.score) })),
  };
};
