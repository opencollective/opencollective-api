/**
 * Builds the single statement that returns, for one entity request, the total, the offset-independent maximum score
 * and the requested page. Being a single statement, all three come from the same snapshot.
 *
 * Exact (default): every match is scored and counted, so the cost grows with the number of matches.
 *
 *   WITH arms AS (<arm 1> UNION ALL <arm 2> ...),
 *        best AS MATERIALIZED (SELECT id, max(score) AS score FROM arms GROUP BY id),
 *        agg AS (SELECT count(*) AS total, coalesce(max(score), 0) AS "maxScore" FROM best)
 *   SELECT agg.total, agg."maxScore", page.id, page.score
 *   FROM agg LEFT JOIN LATERAL (SELECT ... FROM best ORDER BY score DESC, id DESC LIMIT $l OFFSET $o) page ON TRUE
 *
 * An empty later page still returns the `agg` row (with a NULL page), so totals and maxScore are always exact.
 *
 * Capped (adapters with `constantScorePerArm`): the cost is bounded by the page depth and the cap, not the matches.
 *
 *   WITH page AS (SELECT id, max(score) AS score FROM (<arm 1 ORDER BY id DESC LIMIT offset+limit> UNION ALL ...)
 *                 GROUP BY id ORDER BY score DESC, id DESC LIMIT $l OFFSET $o),
 *        agg AS (SELECT count(DISTINCT id) AS total, coalesce(max(score), 0) AS "maxScore"
 *                FROM (<arm 1 LIMIT cap+1> UNION ALL ...))
 *   SELECT agg.total, agg."maxScore", page.id, page.score FROM agg LEFT JOIN page ON TRUE ORDER BY page.score DESC, page.id DESC
 *
 * - Page: when an arm's score is constant, its rows are ranked by `id DESC` among themselves, so a hit of the global
 *   top `offset + limit` is always within the top `offset + limit` of its best arm. Each arm can then stop early
 *   (e.g. a backward primary key scan for a broad word), and the page is the same as the exact one.
 * - Scoped requests (account or host) order by `id + 0` instead, which rules out the backward primary key scan. The
 *   planner estimates scope and text as independent, so a scope without matches for a word that is common elsewhere
 *   ("platform tip" on a host without platform tips) scanned the whole table: 5 s on 13M rows, vs 0.4 s from the
 *   scope's index. The cost is then bounded by the matches of the scope, not by the table.
 * - Total: an arm that reaches `cap + 1` rows alone makes the total exceed the cap; otherwise every arm was read in
 *   full and the count is exact. Totals above the cap are returned as the cap, with `totalCountIsCapped`.
 * - maxScore: every non-empty arm returns at least one row, so it stays exact.
 */

import { Kysely, sql } from 'kysely';

import type { DatabaseWithViews } from '../../../kysely';
import type { SearchEntityResult } from '../../types';

import type { SearchArm } from './adapters/types';

type RankedRow = { total: number; maxScore: number; id: number | null; score: number | null };

type SearchPage = { limit: number; offset: number };

type CappedSearchPage = SearchPage & { cap: number; scoped?: boolean };

const unionAll = (arms: SearchArm[]) => arms.slice(1).reduce((query, arm) => query.unionAll(arm), arms[0]);

/**
 * The ranked statement for these arms (see above). Exposed separately so that benchmarks can `EXPLAIN` the exact SQL.
 */
export const buildRankedSearchQuery = (
  db: Kysely<DatabaseWithViews>,
  arms: SearchArm[],
  { limit, offset }: SearchPage,
) => {
  return db
    .with('arms', () => unionAll(arms))
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
    .select(['agg.total', 'agg.maxScore', 'page.id', 'page.score']);
};

/**
 * The capped statement for these arms (see above). Every arm must have a constant score. Exposed separately so that
 * benchmarks can `EXPLAIN` the exact SQL.
 */
export const buildCappedSearchQuery = (
  db: Kysely<DatabaseWithViews>,
  arms: SearchArm[],
  { limit, offset, cap, scoped }: CappedSearchPage,
) => {
  // Each arm is wrapped in its own subquery, so that its ORDER BY/LIMIT applies to it and not to the union
  const limitArms = (limitArm: (arm: SearchArm) => SearchArm) =>
    unionAll(
      arms.map(
        (arm, index) =>
          db.selectFrom(limitArm(arm).as(`arm${index}`)).select([`arm${index}.id`, `arm${index}.score`]) as SearchArm,
      ),
    );

  // `id + 0` sorts the same as `id` but can't use the primary key: on scoped requests, it stops the planner from
  // scanning the whole table backwards when it overestimates the scope's matches (see "Scoped requests" above)
  return db
    .with('page', qb =>
      qb
        .selectFrom(
          limitArms(arm => arm.orderBy(scoped ? sql`id + 0` : sql`id`, 'desc').limit(offset + limit)).as('arms'),
        )
        .select(['arms.id', sql<number>`max(arms.score)`.as('score')])
        .groupBy('arms.id')
        .orderBy('score', 'desc')
        .orderBy('arms.id', 'desc')
        .limit(limit)
        .offset(offset),
    )
    .with('agg', qb =>
      qb
        .selectFrom(limitArms(arm => arm.limit(cap + 1)).as('arms'))
        .select([
          sql<number>`count(DISTINCT arms.id)::int`.as('total'),
          sql<number>`coalesce(max(arms.score), 0)`.as('maxScore'),
        ]),
    )
    .selectFrom('agg')
    .leftJoin('page', join => join.onTrue())
    .select(['agg.total', 'agg.maxScore', 'page.id', 'page.score'])
    .orderBy('page.score', 'desc')
    .orderBy('page.id', 'desc');
};

/**
 * Runs the search: capped (see above) when `cap` is set, exact otherwise. `scoped` only applies to capped searches.
 */
export const executeSearchQuery = async (
  db: Kysely<DatabaseWithViews>,
  arms: SearchArm[],
  { limit, offset, cap, scoped }: SearchPage & { cap?: number; scoped?: boolean },
): Promise<SearchEntityResult> => {
  if (!arms.length) {
    return { totalCount: 0, maxScore: 0, hits: [] };
  }

  const query = cap
    ? buildCappedSearchQuery(db, arms, { limit, offset, cap, scoped })
    : buildRankedSearchQuery(db, arms, { limit, offset });
  const rows = (await query.execute()) as RankedRow[];
  const total = Number(rows[0]?.total ?? 0);

  return {
    totalCount: cap ? Math.min(total, cap) : total,
    ...(cap ? { totalCountIsCapped: total > cap } : {}),
    maxScore: Number(rows[0]?.maxScore ?? 0),
    hits: rows.filter(row => row.id !== null).map(row => ({ id: Number(row.id), score: Number(row.score) })),
  };
};
