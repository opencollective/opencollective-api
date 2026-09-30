/**
 * Remove legacy W9 tax-bot data from Collectives and Activities JSONB columns.
 *
 * `Collectives.data.W9` (`{ receivedFromUserIds, requestSentToUserIds }`) was written by
 * the W9 bot, which was removed in 2019. No active code reads or writes it. Historical
 * collective snapshots embedded in `Activities.data` (e.g. `host.data.W9`,
 * `virtualCard.host.data.W9`) still carry copies.
 *
 * All key removal happens in SQL: the collectives phase strips the root `W9` key,
 * and the activities phase strips it from an explicit list of snapshot locations
 * (`ACTIVITY_W9_PARENT_PATHS`) via guarded `#-` operators. Every phase reports
 * the reclaimed size (KB/MB) per batch plus a running total.
 *
 * Performance (no index required, no state files): each run scans at most
 * `scanBudget` rows (default 1,000,000, calibrated to ~30s on 5.7M rows at
 * ~38k rows/s) past `--after-id`, so no statement can run away on huge tables.
 * Resume by passing the printed `lastId` as the next run's `--after-id`.
 * `complete=true` is only reported once the scan reaches the end of the table.
 *
 * Usage:
 *   # Dry run (default) - reports reclaimable rows and KB without writing
 *   npm run script scripts/cleanup/strip-w9-data-from-jsonb.ts
 *
 *   # Apply to up to 500 rows per phase; rerun to continue
 *   DRY_RUN=false npm run script scripts/cleanup/strip-w9-data-from-jsonb.ts
 *
 *   # Update up to 5,000 rows per phase in batches of 500
 *   DRY_RUN=false npm run script scripts/cleanup/strip-w9-data-from-jsonb.ts -- --batch-size 500 --limit 5000
 *
 *   # Each run scans at most scanBudget rows past --after-id (default 1,000,000).
 *   # Resume with the printed lastId; repeat until complete=true. No state files.
 *   DRY_RUN=false npm run script scripts/cleanup/strip-w9-data-from-jsonb.ts -- --phase activities --after-id 5000000 --limit 10000
 */

import '../../server/env';

import { Command } from 'commander';
import type { Sequelize, Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';

import logger from '../../server/lib/logger';
import { formatSize } from '../../server/lib/math';
import { parseToBoolean } from '../../server/lib/utils';
import { sequelize } from '../../server/models';

const BATCH_SIZE = 500;

/**
 * Maximum table rows examined per run past `--after-id`. Bounds every statement
 * so huge tables can't stall a run; resume with the printed `lastId`.
 * Calibrated from a production probe (~38k rows/s for the activities filter).
 */
const SCAN_BUDGET = 1_000_000;

/** Per-batch statement timeout (fixed safety net, not operator-facing). */
const STATEMENT_TIMEOUT_MS = 300_000;

/** Breathing room between batches so the primary stays responsive. */
const INTER_BATCH_DELAY_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Run batch work with a fixed statement timeout, without leaking session state to the pool. */
const runWithBatchTimeout = async <T>(
  db: Sequelize,
  work: (transaction: Transaction) => Promise<T>,
  { disableSeqScan = false }: { disableSeqScan?: boolean } = {},
): Promise<T> =>
  db.transaction(async transaction => {
    await db.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}'`, { transaction });
    if (disableSeqScan) {
      await db.query('SET LOCAL enable_seqscan = off', { transaction });
    }
    return work(transaction);
  });

type ScannableTable = 'Collectives' | 'Activities';

/** End of the per-run scan window: at most `scanBudget` rows past `afterId`. */
type ScanWindow = {
  stopId: number | null;
  reachesEnd: boolean;
};

const probeWindow = async (
  db: Sequelize,
  table: ScannableTable,
  afterId: number,
  scanBudget: number,
): Promise<ScanWindow> => {
  const rows = await db.query<{ id: number }>(
    `SELECT id FROM "${table}" WHERE id > :afterId ORDER BY id ASC LIMIT 2 OFFSET :offset`,
    { replacements: { afterId, offset: scanBudget - 1 }, type: QueryTypes.SELECT },
  );
  if (rows.length === 0) {
    return { stopId: null, reachesEnd: true };
  }
  return { stopId: rows[0].id, reachesEnd: rows.length < 2 };
};

const countWindow = async (
  db: Sequelize,
  table: ScannableTable,
  afterId: number,
  stopId: number | null,
): Promise<number> => {
  const rows = await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM "${table}"
     WHERE id > :afterId${stopId === null ? '' : ' AND id <= :stopId'}`,
    { replacements: { afterId, stopId }, type: QueryTypes.SELECT },
  );
  return rows[0]?.count ?? 0;
};

/**
 * Explicit `Activities.data` snapshot locations that may hold a legacy `W9` key.
 * Entries are parent paths; the `W9` key itself is appended when building queries.
 * Top-level keys mirror the collective snapshots embedded by activity creators
 * (`host`, `collective`, ...); `virtualCard.*` covers virtual-card payloads that
 * embed host/collective snapshots, including their historical `spamReport.data`
 * sub-snapshots. Verified against production-shaped data: every `**.data.W9`
 * occurrence matches one of these paths.
 */
const ACTIVITY_W9_PARENT_PATHS: readonly (readonly string[])[] = [
  ['host', 'data'],
  ['collective', 'data'],
  ['fromCollective', 'data'],
  ['toCollective', 'data'],
  ['movedFromCollective', 'data'],
  ['hostCollective', 'data'],
  ['previousData', 'data'],
  ['newData', 'data'],
  ['virtualCard', 'host', 'data'],
  ['virtualCard', 'collective', 'data'],
  ['virtualCard', 'host', 'data', 'spamReport', 'data', 'data'],
  ['virtualCard', 'collective', 'data', 'spamReport', 'data', 'data'],
];

const pgTextArray = (parts: readonly string[]): string => `'{${parts.join(',')}}'`;

const activityW9JsonPath = (parts: readonly string[]): string => `$.${[...parts, 'W9'].join('.')}`;

const activityW9Flag = (parts: readonly string[]): string => `has_${[...parts, 'W9'].join('_')}`;

const ACTIVITIES_W9_WHERE = (column: string): string =>
  ACTIVITY_W9_PARENT_PATHS.map(parts => `${column} @? '${activityW9JsonPath(parts)}'`).join('\n    OR ');

/**
 * Removal expression chaining one guarded `#-` per path. The `jsonb_typeof`
 * guard skips non-object parents (`#-` raises on array intermediates), so a
 * single malformed row can never fail the batch.
 */
const ACTIVITIES_W9_REMOVAL = (column: string): string =>
  ACTIVITY_W9_PARENT_PATHS.reduce(
    (expr, parts) =>
      `(CASE WHEN jsonb_typeof(${column} #> ${pgTextArray(parts)}) = 'object' ` +
      `THEN (${expr}) #- ${pgTextArray([...parts, 'W9'])}::text[] ELSE (${expr}) END)`,
    column,
  );

const ACTIVITIES_W9_FLAGS = (column: string): string =>
  ACTIVITY_W9_PARENT_PATHS.map(
    parts => `(${column} @? '${activityW9JsonPath(parts)}') AS "${activityW9Flag(parts)}"`,
  ).join(',\n         ');

const ACTIVITY_W9_FLAG_PATHS: Record<string, string> = Object.fromEntries(
  ACTIVITY_W9_PARENT_PATHS.map(parts => [activityW9Flag(parts), [...parts, 'W9'].join('.')]),
);

type StripW9Phase = 'collectives' | 'activities' | 'all';

type StripW9Options = {
  dryRun?: boolean;
  batchSize?: number;
  limit?: number;
  afterId?: number;
  scanBudget?: number;
};

type PhaseStats = {
  processed: number;
  updated: number;
  bytesSaved: number;
  scanned: number;
  lastId: number;
  complete: boolean;
};

type Estimate = {
  count: number;
  bytes: number;
};

const estimateCollectives = async (db: Sequelize): Promise<Estimate> => {
  const rows = await db.query<{ count: number; bytes: string }>(
    `
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(octet_length((data->'W9')::text)), 0)::bigint AS bytes
      FROM "Collectives"
      WHERE data ? 'W9';
    `,
    { type: QueryTypes.SELECT },
  );
  return { count: rows[0]?.count ?? 0, bytes: Number(rows[0]?.bytes ?? 0) };
};

const COLLECTIVES_DRY_RUN_QUERY = (bounded: boolean) => `
  SELECT id,
         octet_length(data::text) AS before_size,
         octet_length((data - 'W9')::text) AS after_size
  FROM "Collectives"
  WHERE id > :afterId
    AND data ? 'W9'
    ${bounded ? 'AND id <= :stopId' : ''}
  ORDER BY id ASC
  LIMIT :batchSize
`;

const COLLECTIVES_UPDATE_QUERY = (bounded: boolean) => `
  WITH candidates AS (
    SELECT id, data
    FROM "Collectives"
    WHERE id > :afterId
      AND data ? 'W9'
      ${bounded ? 'AND id <= :stopId' : ''}
    ORDER BY id ASC
    LIMIT :batchSize
  )
  UPDATE "Collectives" AS c
  SET data = c.data - 'W9'
  FROM candidates
  WHERE c.id = candidates.id
  RETURNING c.id AS id,
            (octet_length(candidates.data::text) - octet_length(c.data::text)) AS bytes_saved
`;

const ACTIVITIES_DRY_RUN_QUERY = (bounded: boolean) => `
  SELECT id,
         octet_length(data::text) AS before_size,
         octet_length((${ACTIVITIES_W9_REMOVAL('data')})::text) AS after_size,
         ${ACTIVITIES_W9_FLAGS('data')}
  FROM "Activities"
  WHERE id > :afterId
    ${bounded ? 'AND id <= :stopId' : ''}
    AND strpos(data::text, '"W9"') > 0
    AND (
      ${ACTIVITIES_W9_WHERE('data')}
    )
  ORDER BY id ASC
  LIMIT :batchSize
`;

const ACTIVITIES_UPDATE_QUERY = (bounded: boolean) => `
  WITH candidates AS (
    SELECT id, data
    FROM "Activities"
    WHERE id > :afterId
      ${bounded ? 'AND id <= :stopId' : ''}
      AND strpos(data::text, '"W9"') > 0
      AND (
        ${ACTIVITIES_W9_WHERE('data')}
      )
    ORDER BY id ASC
    LIMIT :batchSize
  )
  UPDATE "Activities" AS a
  SET data = ${ACTIVITIES_W9_REMOVAL('a.data')}
  FROM candidates
  WHERE a.id = candidates.id
  RETURNING a.id AS id,
            (octet_length(candidates.data::text) - octet_length(a.data::text)) AS bytes_saved,
            ${ACTIVITIES_W9_FLAGS('candidates.data')}
`;

type ActivityW9Row = {
  id: number;
  before_size?: number | string;
  after_size?: number | string;
  bytes_saved?: number | string;
  [flag: string]: unknown;
};

const activityW9RemovedPaths = (row: ActivityW9Row): string[] =>
  Object.keys(ACTIVITY_W9_FLAG_PATHS).filter(flag => Boolean(row[flag]));

const runCollectivesPhase = async (db: Sequelize, options: StripW9Options): Promise<PhaseStats> => {
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const limit = options.limit;
  const scanBudget = options.scanBudget ?? SCAN_BUDGET;
  let afterId = options.afterId ?? 0;
  let processed = 0;
  let updated = 0;
  let bytesSaved = 0;

  const { stopId, reachesEnd } = await probeWindow(db, 'Collectives', afterId, scanBudget);
  const scanned = await countWindow(db, 'Collectives', afterId, stopId);
  logger.info(
    `collectives: scanning at most ${scanned} rows in this run (afterId=${afterId}${stopId === null ? '' : `, stopId=${stopId}`})`,
  );

  while (true) {
    if (limit !== undefined && processed >= limit) {
      break;
    }

    const effectiveBatchSize = limit !== undefined ? Math.min(batchSize, limit - processed) : batchSize;
    const bounded = stopId !== null;

    const rows = await runWithBatchTimeout(db, transaction =>
      db.query<{
        id: number;
        before_size?: number | string;
        after_size?: number | string;
        bytes_saved?: number | string;
      }>(dryRun ? COLLECTIVES_DRY_RUN_QUERY(bounded) : COLLECTIVES_UPDATE_QUERY(bounded), {
        replacements: { afterId, batchSize: effectiveBatchSize, stopId },
        type: QueryTypes.SELECT,
        transaction,
      }),
    );

    if (rows.length === 0) {
      // Window exhausted: everything up to stopId was examined, so resume past it.
      // (stopId null means the tail was reached: nothing left at all.)
      return { processed, updated, bytesSaved, scanned, lastId: stopId ?? afterId, complete: reachesEnd };
    }

    for (const row of rows) {
      processed++;
      afterId = Math.max(afterId, row.id);
      const saved = dryRun ? Number(row.before_size) - Number(row.after_size) : Number(row.bytes_saved);
      if (saved > 0) {
        updated++;
        bytesSaved += saved;
      }
    }

    logger.info(
      `collectives: batch ${dryRun ? 'would strip W9 from' : 'stripped W9 from'} ${rows.length} rows (total=${processed}, ${dryRun ? 'wouldUpdate' : 'updated'}=${updated}, ${dryRun ? 'wouldSave' : 'saved'}=${formatSize(bytesSaved)}, lastId=${afterId})`,
    );

    if (rows.length < effectiveBatchSize) {
      // Window exhausted (fewer matches than the page fits): resume past stopId,
      // everything up to it was examined. Tail (stopId null) means we're done.
      return { processed, updated, bytesSaved, scanned, lastId: stopId ?? afterId, complete: reachesEnd };
    }

    await sleep(INTER_BATCH_DELAY_MS);
  }

  return { processed, updated, bytesSaved, scanned, lastId: afterId, complete: false };
};

const runActivitiesPhase = async (db: Sequelize, options: StripW9Options): Promise<PhaseStats> => {
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const limit = options.limit;
  const scanBudget = options.scanBudget ?? SCAN_BUDGET;
  let afterId = options.afterId ?? 0;
  let processed = 0;
  let updated = 0;
  let bytesSaved = 0;

  const { stopId, reachesEnd } = await probeWindow(db, 'Activities', afterId, scanBudget);
  const scanned = await countWindow(db, 'Activities', afterId, stopId);
  logger.info(
    `activities: scanning at most ${scanned} rows in this run (afterId=${afterId}${stopId === null ? '' : `, stopId=${stopId}`})`,
  );

  while (true) {
    if (limit !== undefined && processed >= limit) {
      break;
    }

    const effectiveBatchSize = limit !== undefined ? Math.min(batchSize, limit - processed) : batchSize;
    const bounded = stopId !== null;

    const rows = await runWithBatchTimeout(
      db,
      transaction =>
        db.query<ActivityW9Row>(dryRun ? ACTIVITIES_DRY_RUN_QUERY(bounded) : ACTIVITIES_UPDATE_QUERY(bounded), {
          replacements: { afterId, batchSize: effectiveBatchSize, stopId },
          type: QueryTypes.SELECT,
          transaction,
        }),
      // Activities is huge: keep every batch on the pkey range scan so the
      // scan window structurally bounds the work. (Collectives is small enough
      // that a sequential scan is fine, so it doesn't opt in.)
      { disableSeqScan: true },
    );

    if (rows.length === 0) {
      // Window exhausted: everything up to stopId was examined, so resume past it.
      // (stopId null means the tail was reached: nothing left at all.)
      return { processed, updated, bytesSaved, scanned, lastId: stopId ?? afterId, complete: reachesEnd };
    }

    for (const row of rows) {
      processed++;
      afterId = Math.max(afterId, row.id);
      const saved = dryRun ? Number(row.before_size) - Number(row.after_size) : Number(row.bytes_saved);
      const removedPaths = activityW9RemovedPaths(row).map(flag => ACTIVITY_W9_FLAG_PATHS[flag]);

      if (saved > 0) {
        updated++;
        bytesSaved += saved;
        logger.info(
          `activities: id=${row.id} ${dryRun ? 'would remove' : 'removed'} ${removedPaths.join(', ')} (${formatSize(saved)})`,
        );
      }
    }

    logger.info(
      `activities: batch processed ${rows.length} rows (total=${processed}, updated=${updated}, ${dryRun ? 'wouldSave' : 'saved'}=${formatSize(bytesSaved)}, lastId=${afterId})`,
    );

    if (rows.length < effectiveBatchSize) {
      // Window exhausted (fewer matches than the page fits): resume past stopId,
      // everything up to it was examined. Tail (stopId null) means we're done.
      return { processed, updated, bytesSaved, scanned, lastId: stopId ?? afterId, complete: reachesEnd };
    }

    await sleep(INTER_BATCH_DELAY_MS);
  }

  return { processed, updated, bytesSaved, scanned, lastId: afterId, complete: false };
};

const runStripW9DataFromJsonb = async (
  db: Sequelize,
  phase: StripW9Phase,
  options: StripW9Options = {},
): Promise<Record<string, PhaseStats>> => {
  const dryRun = options.dryRun ?? false;
  const results: Record<string, PhaseStats> = {};
  const phasesToRun: StripW9Phase[] = phase === 'all' ? ['collectives', 'activities'] : [phase];

  logger.info(
    `strip-w9-data-from-jsonb: phase=${phase}, dryRun=${dryRun}, batchSize=${options.batchSize ?? BATCH_SIZE}, limit=${options.limit ?? 'none'}, afterId=${options.afterId ?? 0}, scanBudget=${options.scanBudget ?? SCAN_BUDGET}`,
  );

  if (phasesToRun.includes('collectives')) {
    const estimate = await estimateCollectives(db);
    logger.info(`collectives: ~${estimate.count} rows hold data.W9, ~${formatSize(estimate.bytes)} reclaimable`);
  }

  for (const currentPhase of phasesToRun) {
    if (currentPhase === 'collectives') {
      results.collectives = await runCollectivesPhase(db, options);
    } else {
      results.activities = await runActivitiesPhase(db, options);
    }
    const stats = currentPhase === 'collectives' ? results.collectives : results.activities;
    logger.info(
      `${currentPhase}: processed=${stats.processed}, updated=${stats.updated}, scanned=${stats.scanned}, ${dryRun ? 'wouldSave' : 'saved'}=${formatSize(stats.bytesSaved)}, lastId=${stats.lastId}, complete=${stats.complete}${stats.complete ? '' : ` (resume with --after-id ${stats.lastId})`}`,
    );
  }

  const totalBytes = Object.values(results).reduce((sum, stats) => sum + stats.bytesSaved, 0);
  const totalUpdated = Object.values(results).reduce((sum, stats) => sum + stats.updated, 0);
  logger.info(
    `strip-w9-data-from-jsonb: ${dryRun ? 'would update' : 'updated'} ${totalUpdated} rows, ${dryRun ? 'would reclaim' : 'reclaimed'} ${formatSize(totalBytes)} in this run`,
  );

  return results;
};

export async function run({
  dryRun = process.env.DRY_RUN ? parseToBoolean(process.env.DRY_RUN) : true,
  batchSize = BATCH_SIZE,
  limit = batchSize,
  afterId = 0,
  scanBudget = SCAN_BUDGET,
  phase = 'all' as StripW9Phase,
}: {
  dryRun?: boolean;
  batchSize?: number;
  limit?: number;
  afterId?: number;
  scanBudget?: number;
  phase?: StripW9Phase;
} = {}): Promise<Record<string, PhaseStats>> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error('batchSize must be a positive integer');
  }

  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer');
  }

  if (!Number.isSafeInteger(afterId) || afterId < 0) {
    throw new Error('afterId must be a non-negative integer');
  }

  if (!Number.isSafeInteger(scanBudget) || scanBudget <= 0) {
    throw new Error('scanBudget must be a positive integer');
  }

  if (!['collectives', 'activities', 'all'].includes(phase)) {
    throw new Error(`Invalid phase: ${phase}. Expected one of: collectives, activities, all`);
  }

  return runStripW9DataFromJsonb(sequelize, phase, { dryRun, batchSize, limit, afterId, scanBudget });
}

const main = async (): Promise<void> => {
  const program = new Command();
  program
    .option('--phase <name>', 'Phase to run: collectives, activities, or all', 'all')
    .option('--batch-size <n>', 'Rows per batch', Number)
    .option('--limit <n>', 'Max rows to process per phase in this run', Number)
    .option('--after-id <n>', 'Resume cursor (id > after-id, applied per phase)', Number)
    .option('--scan-budget <n>', 'Max table rows to examine per phase in this run', Number);

  // `npm run script <file> -- --flag value` leaves a leading `--` in argv
  // (babel-node forwards it); strip it so commander parses the flags.
  // Direct invocations (`babel-node <file> --flag value`) are unaffected.
  const argv = process.argv.slice(2);
  if (argv[0] === '--') {
    argv.shift();
  }
  program.parse(['node', 'strip-w9-data-from-jsonb', ...argv]);

  const options = program.opts();
  const dryRun = process.env.DRY_RUN ? parseToBoolean(process.env.DRY_RUN) : true;
  const phase = options.phase as StripW9Phase;
  const validPhases: StripW9Phase[] = ['collectives', 'activities', 'all'];

  if (!validPhases.includes(phase)) {
    logger.error(`Invalid phase: ${phase}. Expected one of: ${validPhases.join(', ')}`);
    process.exit(1);
  }

  if (dryRun) {
    logger.info('Running in DRY RUN mode');
  }

  await run({
    dryRun,
    batchSize: options.batchSize,
    limit: options.limit,
    afterId: options.afterId,
    scanBudget: options.scanBudget,
    phase,
  });
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      logger.error(err);
      process.exit(1);
    });
}
