/**
 * Remove legacy W9 tax-bot data from Activities JSONB snapshots.
 *
 * The W9 bot (removed in 2019) wrote `Collectives.data.W9`
 * (`{ receivedFromUserIds, requestSentToUserIds }`). No active code reads or
 * writes it. Historical collective snapshots embedded in `Activities.data`
 * (e.g. `host.data.W9`, `virtualCard.host.data.W9`) still carry copies.
 * (The `Collectives` cleanup already ran, so this script is activities-only.)
 *
 * All key removal happens in SQL: the script strips `W9` from an explicit
 * list of snapshot locations (`ACTIVITY_W9_PARENT_PATHS`) via guarded `#-`
 * operators, and reports the reclaimed size (KB/MB) per batch plus a total.
 *
 * Performance (no index required, no state files): every Activities query is
 * bounded by a probe window. `--batch-size` defines the window: the script
 * probes the `--batch-size`-th id past `--after-id` (e.g. `--batch-size 10`
 * with `--after-id 0` yields `stopId=10` on contiguous ids) and every batch
 * query carries `id > :afterId AND id <= :stopId`, so no statement can run
 * away on the huge Activities table. Resume an interrupted run by passing
 * the printed `lastId` as the next run's `--after-id`.
 * `complete=true` is only reported once the scan reaches the end of the table.
 *
 * Usage:
 *   # Dry run (default) - reports reclaimable rows and KB without writing
 *   npm run script scripts/cleanup/strip-w9-data-from-jsonb.ts
 *
 *   # Apply to up to 500 rows (one default window); rerun to continue
 *   DRY_RUN=false npm run script scripts/cleanup/strip-w9-data-from-jsonb.ts
 *
 *   # Loop through all activities one thousand at a time, stop after one migrated
 *   DRY_RUN=false npm run script scripts/cleanup/strip-w9-data-from-jsonb.ts -- --batch-size 1000 --limit 1
 *
 *   # Same, but starting after ID=1234 (resume cursor)
 *   DRY_RUN=false npm run script scripts/cleanup/strip-w9-data-from-jsonb.ts -- --batch-size 1000 --limit 1 --after-id 1234
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

/** Per-batch statement timeout (fixed safety net, not operator-facing). */
const STATEMENT_TIMEOUT_MS = 300_000;

/** Breathing room between batches so the primary stays responsive. */
const INTER_BATCH_DELAY_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Run batch work with a fixed statement timeout, without leaking session state to the pool. */
const runWithBatchTimeout = async <T>(db: Sequelize, work: (transaction: Transaction) => Promise<T>): Promise<T> =>
  db.transaction(async transaction => {
    await db.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}'`, { transaction });
    // Activities is huge: keep every batch on the pkey range scan so the
    // probe window structurally bounds the work.
    await db.query('SET LOCAL enable_seqscan = off', { transaction });
    return work(transaction);
  });

/** End of a probe window: the `--batch-size`-th id past `afterId`. */
type ScanWindow = {
  stopId: number | null;
  reachesEnd: boolean;
};

const probeWindow = async (db: Sequelize, afterId: number, batchSize: number): Promise<ScanWindow> => {
  const rows = await db.query<{ id: number }>(
    `SELECT id FROM "Activities" WHERE id > :afterId ORDER BY id ASC LIMIT 2 OFFSET :offset`,
    { replacements: { afterId, offset: batchSize - 1 }, type: QueryTypes.SELECT },
  );
  if (rows.length === 0) {
    // Fewer than `batchSize` rows remain: cap the window at the last id so
    // every Activities query stays bounded. No rows at all means we're done.
    const tail = await db.query<{ id: number }>(
      `SELECT id FROM "Activities" WHERE id > :afterId ORDER BY id DESC LIMIT 1`,
      { replacements: { afterId }, type: QueryTypes.SELECT },
    );
    if (tail.length === 0) {
      return { stopId: null, reachesEnd: true };
    }
    return { stopId: tail[0].id, reachesEnd: true };
  }
  return { stopId: rows[0].id, reachesEnd: rows.length < 2 };
};

const countWindow = async (db: Sequelize, afterId: number, stopId: number): Promise<number> => {
  const rows = await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM "Activities" WHERE id > :afterId AND id <= :stopId`,
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

type StripW9Options = {
  dryRun?: boolean;
  batchSize?: number;
  limit?: number;
  afterId?: number;
};

type PhaseStats = {
  processed: number;
  updated: number;
  bytesSaved: number;
  scanned: number;
  lastId: number;
  complete: boolean;
};

const ACTIVITIES_DRY_RUN_QUERY = `
  SELECT id,
         octet_length(data::text) AS before_size,
         octet_length((${ACTIVITIES_W9_REMOVAL('data')})::text) AS after_size,
         ${ACTIVITIES_W9_FLAGS('data')}
  FROM "Activities"
  WHERE id > :afterId
    AND id <= :stopId
    AND strpos(data::text, '"W9"') > 0
    AND (
      ${ACTIVITIES_W9_WHERE('data')}
    )
  ORDER BY id ASC
  LIMIT :batchSize
`;

const ACTIVITIES_UPDATE_QUERY = `
  WITH candidates AS (
    SELECT id, data
    FROM "Activities"
    WHERE id > :afterId
      AND id <= :stopId
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

const runActivities = async (db: Sequelize, options: StripW9Options): Promise<PhaseStats> => {
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const limit = options.limit ?? batchSize;
  let afterId = options.afterId ?? 0;
  let processed = 0;
  let updated = 0;
  let bytesSaved = 0;
  let scanned = 0;

  logger.info(`activities: migrating up to ${limit} rows in windows of ${batchSize} (afterId=${afterId})`);

  while (true) {
    if (processed >= limit) {
      break;
    }

    const { stopId, reachesEnd } = await probeWindow(db, afterId, batchSize);
    if (stopId === null) {
      return { processed, updated, bytesSaved, scanned, lastId: afterId, complete: true };
    }
    scanned += await countWindow(db, afterId, stopId);
    logger.info(`activities: window afterId=${afterId}, stopId=${stopId} (~${scanned} rows scanned so far)`);

    const effectiveBatchSize = Math.min(batchSize, limit - processed);

    const rows = await runWithBatchTimeout(db, transaction =>
      db.query<ActivityW9Row>(dryRun ? ACTIVITIES_DRY_RUN_QUERY : ACTIVITIES_UPDATE_QUERY, {
        replacements: { afterId, batchSize: effectiveBatchSize, stopId },
        type: QueryTypes.SELECT,
        transaction,
      }),
    );

    if (rows.length === 0) {
      // Window holds no matches: everything up to stopId was examined, resume past it.
      afterId = stopId;
      if (reachesEnd) {
        return { processed, updated, bytesSaved, scanned, lastId: afterId, complete: true };
      }
      continue;
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
      // Fewer matches than the page fits: every match in the window was seen,
      // so resume past stopId. Tail window means we're done.
      afterId = stopId;
      if (reachesEnd) {
        return { processed, updated, bytesSaved, scanned, lastId: afterId, complete: true };
      }
    }

    await sleep(INTER_BATCH_DELAY_MS);
  }

  return { processed, updated, bytesSaved, scanned, lastId: afterId, complete: false };
};

export async function run({
  dryRun = process.env.DRY_RUN ? parseToBoolean(process.env.DRY_RUN) : true,
  batchSize = BATCH_SIZE,
  limit = batchSize,
  afterId = 0,
}: {
  dryRun?: boolean;
  batchSize?: number;
  limit?: number;
  afterId?: number;
} = {}): Promise<PhaseStats> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error('batchSize must be a positive integer');
  }

  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer');
  }

  if (!Number.isSafeInteger(afterId) || afterId < 0) {
    throw new Error('afterId must be a non-negative integer');
  }

  logger.info(`strip-w9-data-from-jsonb: dryRun=${dryRun}, batchSize=${batchSize}, limit=${limit}, afterId=${afterId}`);

  const stats = await runActivities(sequelize, { dryRun, batchSize, limit, afterId });
  logger.info(
    `activities: processed=${stats.processed}, updated=${stats.updated}, scanned=${stats.scanned}, ${dryRun ? 'wouldSave' : 'saved'}=${formatSize(stats.bytesSaved)}, lastId=${stats.lastId}, complete=${stats.complete}${stats.complete ? '' : ` (resume with --after-id ${stats.lastId})`}`,
  );

  return stats;
}

const main = async (): Promise<void> => {
  const program = new Command();
  program
    .option('--batch-size <n>', 'Probe window size: migrate in windows of n Activities ids', Number)
    .option('--limit <n>', 'Max rows to migrate in this run', Number)
    .option('--after-id <n>', 'Resume cursor (only rows with id > after-id are examined)', Number);

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

  if (dryRun) {
    logger.info('Running in DRY RUN mode');
  }

  await run({
    dryRun,
    batchSize: options.batchSize,
    limit: options.limit,
    afterId: options.afterId,
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
