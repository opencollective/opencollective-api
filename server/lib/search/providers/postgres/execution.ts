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

/** Environment variables arrive as strings (`SEARCH_POSTGRES_*`, see `docs/environment_variables.md`) */
const parseTypoSimilarityThreshold = (value: unknown): number => {
  const threshold = Number(value);
  if (value === '' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`Invalid search.postgres.typoSimilarityThreshold: ${String(value)} (expected a number in [0, 1])`);
  }

  return threshold;
};

/** Without this check, a missing or non-numeric value would silently remove the cap, and 0 would block every search */
const parseMaxConcurrentQueries = (value: unknown): number => {
  const max = Number(value);
  if (value === '' || !Number.isInteger(max) || max < 1) {
    throw new Error(`Invalid search.postgres.maxConcurrentQueries: ${String(value)} (expected a positive integer)`);
  }

  return max;
};

const getPostgresSearchConfig = () => ({
  workMem: String(config.search.postgres.workMem),
  maxConcurrentQueries: parseMaxConcurrentQueries(config.search.postgres.maxConcurrentQueries),
  typoSimilarityThreshold: parseTypoSimilarityThreshold(config.search.postgres.typoSimilarityThreshold),
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

/** Passed to the statements of a search transaction */
type SearchBudgetControl = {
  /**
   * Sets `statement_timeout` to the time left before the deadline (or throws `SearchBudgetExceeded`). Call it before
   * each statement after the first one: PostgreSQL applies `statement_timeout` per statement, so without it a
   * transaction of several statements could run for several times its budget.
   */
  renewStatementTimeout(): Promise<void>;
};

const getRemainingMs = (deadline: number): number => {
  const remainingMs = Math.floor(deadline - Date.now());
  if (remainingMs <= 0) {
    throw new SearchBudgetExceeded();
  }

  return remainingMs;
};

/** Rejects with `SearchBudgetExceeded` if `promise` has not settled by the deadline */
const settleBeforeDeadline = async <T>(promise: Promise<T>, deadline: number): Promise<T> => {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SearchBudgetExceeded()), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Runs `fn` in a read-only transaction whose statements are canceled by PostgreSQL once the deadline is reached.
 * Throws `SearchBudgetExceeded` if the deadline is reached before or during execution, including while waiting for a
 * search slot or for a connection of the shared pool.
 */
export const runWithSearchBudget = async <T>(
  { deadline }: SearchBudget,
  fn: (trx: Kysely<DatabaseWithViews>, budget: SearchBudgetControl) => Promise<T>,
): Promise<T> => {
  const release = await acquireSlot(deadline);
  let onConnection: () => void;
  const connected = new Promise<void>(resolve => (onConnection = resolve));
  const execution = getKysely()
    .transaction()
    .execute(async trx => {
      onConnection();
      // Also stops a search that got its connection after the deadline (`settleBeforeDeadline` below gave up on it)
      const remainingMs = getRemainingMs(deadline);
      const { workMem, typoSimilarityThreshold } = getPostgresSearchConfig();
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      // JIT off: search plans are estimated as expensive (text matches) but usually run in milliseconds, and compiling
      // their permission expressions took seconds (measured on Comments: 3.2 s -> 22 ms without JIT).
      // No parallel workers: each search statement uses at most one core (and one `work_mem` per node), so that
      // concurrent searches can't take over the CPU of the primary. Measured with 8 concurrent users on 4 vCPU: 67% more
      // searches per second and half the median latency, for a slower p95 when searching alone (0.6 s -> 0.9 s).
      // Prefetching for bitmap heap scans instead (never lower than the server's setting): without parallel workers,
      // searches on uncached data read one page at a time (cold, 2.8M Orders matches: 9.1 s -> 6.7 s). A server setting
      // of 0 is kept: platforms without posix_fadvise() (e.g. macOS) reject any other value.
      await sql`
        SELECT
          set_config('statement_timeout', ${String(remainingMs)}, true),
          set_config('work_mem', ${workMem}, true),
          set_config('pg_trgm.word_similarity_threshold', ${String(typoSimilarityThreshold)}, true),
          set_config('jit', 'off', true),
          set_config('max_parallel_workers_per_gather', '0', true),
          set_config(
            'effective_io_concurrency',
            CASE current_setting('effective_io_concurrency')::int
              WHEN 0 THEN '0'
              ELSE greatest(current_setting('effective_io_concurrency')::int, 64)::text
            END,
            true
          )
      `.execute(trx);

      return fn(trx, {
        async renewStatementTimeout() {
          await sql`SELECT set_config('statement_timeout', ${String(getRemainingMs(deadline))}, true)`.execute(trx);
        },
      });
    });

  // The slot is held until the transaction is over, even if the search gave up on waiting for a connection
  execution.then(release, release);
  try {
    // The pool waits for a free connection without a deadline of its own (`database.options.pool.acquire`)
    await settleBeforeDeadline(Promise.race([connected, execution]), deadline);
    return await execution;
  } catch (error) {
    if (isQueryCanceled(error)) {
      throw new SearchBudgetExceeded();
    }

    throw error;
  }
};
