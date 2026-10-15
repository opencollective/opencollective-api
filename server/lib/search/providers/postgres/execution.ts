/**
 * Execution budget for PostgreSQL search statements.
 *
 * Every entity query runs in its own read-only transaction on the shared pool, with transaction-local settings
 * (`set_config(..., true)` = `SET LOCAL`): they are reset on COMMIT/ROLLBACK, before the connection is returned to
 * the pool. JIT compilation is disabled: on large tables, the planner's cost estimates enable it for searches that
 * then take a millisecond, and compiling costs 300+ ms (measured on Transactions merchant ID lookups). Parallel workers
 * are disabled too, so that one search statement uses at most one core.
 * `statement_timeout` is what actually cancels the work in PostgreSQL (a JS timeout alone would leave the
 * query running and holding a connection).
 */

import config from 'config';
import { Kysely, sql } from 'kysely';
import { get } from 'lodash';

import { DatabaseWithViews, getKysely } from '../../../kysely';

const QUERY_CANCELED_SQLSTATE = '57014';

export class SearchBudgetExceeded extends Error {}

type SearchBudget = {
  /** Absolute deadline (ms timestamp) */
  deadline: number;
};

const getPostgresSearchConfig = () => ({
  workMem: String(config.search.postgres.workMem),
  maxConcurrentQueries: Number(config.search.postgres.maxConcurrentQueries),
  typoSimilarityThreshold: String(config.search.postgres.typoSimilarityThreshold),
});

/**
 * Process-wide cap on concurrent search statements, so that search traffic can't take over the shared pool.
 */
const waitingQueue: Array<() => void> = [];
let runningQueries = 0;

const acquireSlot = async (deadline: number): Promise<() => void> => {
  const { maxConcurrentQueries } = getPostgresSearchConfig();
  if (runningQueries >= maxConcurrentQueries) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const index = waitingQueue.indexOf(onSlot);
          if (index !== -1) {
            waitingQueue.splice(index, 1);
          }
          reject(new SearchBudgetExceeded());
        },
        Math.max(0, deadline - Date.now()),
      );
      const onSlot = () => {
        clearTimeout(timer);
        resolve();
      };
      waitingQueue.push(onSlot);
    });
  } else {
    runningQueries++;
  }

  let released = false;
  return () => {
    if (!released) {
      released = true;
      const next = waitingQueue.shift();
      if (next) {
        next(); // Hand over the slot
      } else {
        runningQueries--;
      }
    }
  };
};

/** Current use of the process-wide cap (for monitoring and benchmarks) */
export const getPostgresSearchQueueStats = (): { running: number; waiting: number } => ({
  running: runningQueries,
  waiting: waitingQueue.length,
});

const isQueryCanceled = (error: unknown): boolean =>
  [get(error, 'code'), get(error, 'parent.code'), get(error, 'original.code')].some(
    code => code === QUERY_CANCELED_SQLSTATE,
  );

/**
 * Runs `fn` in a read-only transaction whose statements are canceled by PostgreSQL once the deadline is reached.
 * Throws `SearchBudgetExceeded` if the deadline is reached before or during execution.
 */
export const runWithSearchBudget = async <T>(
  { deadline }: SearchBudget,
  fn: (trx: Kysely<DatabaseWithViews>) => Promise<T>,
): Promise<T> => {
  const release = await acquireSlot(deadline);
  try {
    return await getKysely()
      .transaction()
      .execute(async trx => {
        const remainingMs = Math.floor(deadline - Date.now());
        if (remainingMs <= 0) {
          throw new SearchBudgetExceeded();
        }

        const { workMem, typoSimilarityThreshold } = getPostgresSearchConfig();
        await sql`SET TRANSACTION READ ONLY`.execute(trx);
        // JIT off: search plans are estimated as expensive (text matches) but usually run in milliseconds, and compiling
        // their permission expressions took seconds (measured on Comments: 3.2 s -> 22 ms without JIT).
        // No parallel workers: each search statement uses at most one core (and one `work_mem` per node), so that
        // concurrent searches can't take over the CPU of the primary. Measured with 8 concurrent users on 4 vCPU: 67% more
        // searches per second and half the median latency, for a slower p95 when searching alone (0.6 s -> 0.9 s).
        await sql`
          SELECT
            set_config('statement_timeout', ${String(remainingMs)}, true),
            set_config('work_mem', ${workMem}, true),
            set_config('pg_trgm.word_similarity_threshold', ${typoSimilarityThreshold}, true),
            set_config('jit', 'off', true),
            set_config('max_parallel_workers_per_gather', '0', true)
        `.execute(trx);

        return fn(trx);
      });
  } catch (error) {
    if (isQueryCanceled(error)) {
      throw new SearchBudgetExceeded();
    }

    throw error;
  } finally {
    release();
  }
};
