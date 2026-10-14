/**
 * Fast failure for searches that can't complete within their budget.
 *
 * Exact totals need every match (one heap visit each), so the cost of a search grows with its number of matches. On
 * very large tables, a broad term ("contribution", "fee") can match millions of rows: running it would hold a pooled
 * connection until `statement_timeout` cancels it, and fail anyway. Adapters can opt in to a cheap check first: the
 * planner's estimate of the matches (one `EXPLAIN`, no execution) compared to what can be counted in the remaining
 * budget. Above it, the search fails with the same visible "narrow your search" error as a timeout, in milliseconds.
 *
 * Estimates come from the statistics of non-partial expression indexes and can be several times off for correlated
 * words: the limit is a lenient fast path, `statement_timeout` stays the actual guarantee. It never caps a total.
 */

import { Kysely, sql } from 'kysely';

import type { DatabaseWithViews } from '../../../kysely';

import type { SearchArm } from './adapters/types';
import { SearchBudgetExceeded } from './execution';

const estimateMatches = async (db: Kysely<DatabaseWithViews>, arms: SearchArm[]): Promise<number> => {
  const union = arms.slice(1).reduce((query, arm) => query.unionAll(arm), arms[0]);
  const { rows } = await sql<{
    'QUERY PLAN': unknown;
  }>`EXPLAIN (FORMAT JSON) SELECT id FROM ${union.as('arms')}`.execute(db);
  const rawPlan = rows[0]?.['QUERY PLAN'];
  const plan = typeof rawPlan === 'string' ? JSON.parse(rawPlan) : rawPlan;
  return Number(plan?.[0]?.Plan?.['Plan Rows'] ?? 0);
};

/**
 * Throws `SearchBudgetExceeded` if the arms are estimated to match more rows than `matchesPerSecond` allows within
 * the time left before `deadline`.
 */
export const assertEstimatedMatchesWithinBudget = async (
  db: Kysely<DatabaseWithViews>,
  arms: SearchArm[],
  { matchesPerSecond, deadline }: { matchesPerSecond: number; deadline: number },
): Promise<void> => {
  if (!arms.length) {
    return;
  }

  const maxMatches = (matchesPerSecond * Math.max(0, deadline - Date.now())) / 1000;
  if ((await estimateMatches(db, arms)) > maxMatches) {
    throw new SearchBudgetExceeded();
  }
};
