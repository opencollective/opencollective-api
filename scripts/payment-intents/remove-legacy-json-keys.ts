/**
 * Remove legacy paymentIntent / previousPaymentIntents JSON keys from Orders and Expenses.
 *
 * Usage:
 *   # Dry run (default)
 *   npm run script scripts/payment-intents/remove-legacy-json-keys.ts
 *
 *   # Apply all phases
 *   DRY_RUN=false npm run script scripts/payment-intents/remove-legacy-json-keys.ts
 *
 *   # Resume / partial
 *   DRY_RUN=false npm run script scripts/payment-intents/remove-legacy-json-keys.ts -- --phase remove-legacy-orders --after-id 500000 --limit 10000
 */

import '../../server/env';

import { Command } from 'commander';
import type { Sequelize } from 'sequelize';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

type RemoveLegacyJsonKeysPhase =
  | 'backfill-orders'
  | 'backfill-expenses'
  | 'remove-legacy-orders'
  | 'remove-legacy-expenses'
  | 'drop-indexes'
  | 'all';

type TableName = 'Orders' | 'Expenses';

type RemoveLegacyJsonKeysOptions = {
  dryRun?: boolean;
  batchSize?: number;
  limit?: number;
  afterId?: number;
};

type PhaseStats = {
  processed: number;
  lastId: number;
  complete: boolean;
};

const PHASES: RemoveLegacyJsonKeysPhase[] = [
  'backfill-orders',
  'backfill-expenses',
  'remove-legacy-orders',
  'remove-legacy-expenses',
  'drop-indexes',
];

const LEGACY_KEYS_WHERE = `(data ? 'paymentIntent' OR data ? 'previousPaymentIntents')`;

const getBackfillDataSQL = (table: TableName) => `
  UPDATE "${table}"
  SET data = data
    || CASE
      WHEN data ? 'paymentIntent' AND NOT data ? 'stripePaymentIntent'
      THEN jsonb_build_object('stripePaymentIntent', data->'paymentIntent')
      ELSE '{}'::jsonb
    END
    || CASE
      WHEN data ? 'previousPaymentIntents' AND NOT data ? 'previousStripePaymentIntents'
      THEN jsonb_build_object('previousStripePaymentIntents', data->'previousPaymentIntents')
      ELSE '{}'::jsonb
    END
  WHERE id IN (
    SELECT id
    FROM "${table}"
    WHERE "deletedAt" IS NULL
      AND ${LEGACY_KEYS_WHERE}
      AND id > :afterId
    ORDER BY id ASC
    LIMIT :batchSize
  )
  RETURNING id;
`;

const getRemoveLegacyKeysSQL = (table: TableName) => `
  UPDATE "${table}"
  SET data = data - 'paymentIntent' - 'previousPaymentIntents'
  WHERE id IN (
    SELECT id
    FROM "${table}"
    WHERE "deletedAt" IS NULL
      AND ${LEGACY_KEYS_WHERE}
      AND id > :afterId
    ORDER BY id ASC
    LIMIT :batchSize
  )
  RETURNING id;
`;

const formatDuration = (ms: number): string => {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const sec = Math.floor(ms / 1000);
  if (sec < 60) {
    return `${sec}s`;
  }

  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) {
    return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  }

  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
};

const formatEta = (processed: number, total: number, elapsedMs: number): string => {
  if (processed === 0 || processed >= total || elapsedMs === 0) {
    return 'n/a';
  }

  const remaining = total - processed;
  const etaMs = (remaining / processed) * elapsedMs;
  return formatDuration(etaMs);
};

const logBatchProgress = ({
  phaseName,
  dryRun,
  batchNumber,
  batchProcessed,
  processed,
  effectiveTotal,
  afterId,
  phaseStartedAt,
  batchStartedAt,
}: {
  phaseName: string;
  dryRun: boolean;
  batchNumber: number;
  batchProcessed: number;
  processed: number;
  effectiveTotal: number;
  afterId: number;
  phaseStartedAt: number;
  batchStartedAt: number;
}): void => {
  const elapsedMs = Date.now() - phaseStartedAt;
  const batchMs = Date.now() - batchStartedAt;
  const rowsPerSec = batchMs > 0 ? Math.round((batchProcessed / batchMs) * 1000) : batchProcessed;
  const pct = effectiveTotal > 0 ? ((processed / effectiveTotal) * 100).toFixed(1) : 'n/a';
  const remaining = Math.max(effectiveTotal - processed, 0);

  logger.info(
    `${phaseName}: batch ${batchNumber} ${dryRun ? 'scanned' : 'updated'} ${batchProcessed} rows in ${formatDuration(batchMs)} (${rowsPerSec} rows/s) | progress ${processed}/${effectiveTotal} (${pct}%, ~${remaining} left, lastId=${afterId}, elapsed=${formatDuration(elapsedMs)}, eta=${formatEta(processed, effectiveTotal, elapsedMs)})`,
  );
};

const countRemaining = async (db: Sequelize, table: TableName, afterId = 0): Promise<number> => {
  const [rows] = (await db.query(
    `
      SELECT COUNT(*)::int AS count
      FROM "${table}"
      WHERE "deletedAt" IS NULL
        AND ${LEGACY_KEYS_WHERE}
        AND id > :afterId;
    `,
    { replacements: { afterId } },
  )) as [{ count: number }[], unknown];

  return rows[0]?.count ?? 0;
};

const runPaginatedTableUpdate = async ({
  db,
  table,
  mode,
  phaseName,
  totalRemaining,
  options = {},
}: {
  db: Sequelize;
  table: TableName;
  mode: 'backfill' | 'remove';
  phaseName: string;
  totalRemaining: number;
  options?: RemoveLegacyJsonKeysOptions;
}): Promise<PhaseStats> => {
  const batchSize = options.batchSize ?? 1000;
  const limit = options.limit ?? Infinity;
  const dryRun = options.dryRun ?? false;
  let afterId = options.afterId ?? 0;
  let processed = 0;
  let batchNumber = 0;
  let complete = false;
  const phaseStartedAt = Date.now();
  const updateSql = mode === 'backfill' ? getBackfillDataSQL(table) : getRemoveLegacyKeysSQL(table);
  const effectiveTotal = Math.min(totalRemaining, limit);

  logger.info(
    `${phaseName}: ${dryRun ? 'dry-run' : 'updating'} ${table} (mode=${mode}, batchSize=${batchSize}, limit=${Number.isFinite(limit) ? limit : 'none'}, afterId=${afterId}, rowsToProcess=${effectiveTotal})`,
  );

  while (processed < limit) {
    const pageSize = Math.min(batchSize, limit - processed);
    const batchStartedAt = Date.now();
    batchNumber += 1;

    if (dryRun) {
      const [rows] = (await db.query(
        `
          SELECT id
          FROM "${table}"
          WHERE "deletedAt" IS NULL
            AND ${LEGACY_KEYS_WHERE}
            AND id > :afterId
          ORDER BY id ASC
          LIMIT :batchSize
        `,
        { replacements: { afterId, batchSize: pageSize } },
      )) as [{ id: number }[], unknown];

      if (!rows.length) {
        logger.info(`${phaseName}: batch ${batchNumber} - no more rows (lastId=${afterId})`);
        complete = true;
        break;
      }

      const batchProcessed = rows.length;
      processed += batchProcessed;
      afterId = rows[rows.length - 1].id;

      if (rows.length < pageSize) {
        complete = true;
      }

      logBatchProgress({
        phaseName,
        dryRun,
        batchNumber,
        batchProcessed,
        processed,
        effectiveTotal,
        afterId,
        phaseStartedAt,
        batchStartedAt,
      });
    } else {
      const [rows] = (await db.query(updateSql, {
        replacements: { afterId, batchSize: pageSize },
      })) as [{ id: number }[], unknown];

      if (!rows.length) {
        logger.info(`${phaseName}: batch ${batchNumber} - no more rows (lastId=${afterId})`);
        complete = true;
        break;
      }

      const batchProcessed = rows.length;
      processed += batchProcessed;
      afterId = Math.max(...rows.map(({ id }) => id));

      if (rows.length < pageSize) {
        complete = true;
      }

      logBatchProgress({
        phaseName,
        dryRun,
        batchNumber,
        batchProcessed,
        processed,
        effectiveTotal,
        afterId,
        phaseStartedAt,
        batchStartedAt,
      });
    }

    if (complete) {
      break;
    }
  }

  logger.info(
    `${phaseName}: finished ${dryRun ? 'scanning' : 'updating'} ${table} - ${processed} rows in ${batchNumber} batches over ${formatDuration(Date.now() - phaseStartedAt)}, lastId=${afterId}, complete=${complete}`,
  );

  return { processed, lastId: afterId, complete };
};

const logPhaseSummary = (phaseName: string, stats: PhaseStats, dryRun: boolean): void => {
  logger.info(
    `Phase ${phaseName} ${dryRun ? 'would process' : 'processed'} ${stats.processed} rows, lastId=${stats.lastId}, complete=${stats.complete}`,
  );
};

export const runRemoveLegacyJsonKeys = async (
  db: Sequelize,
  phase: RemoveLegacyJsonKeysPhase,
  options: RemoveLegacyJsonKeysOptions = {},
): Promise<Record<string, PhaseStats>> => {
  const dryRun = options.dryRun ?? false;
  const results: Record<string, PhaseStats> = {};
  const phasesToRun = phase === 'all' ? PHASES : [phase];

  logger.info(
    `remove-legacy-json-keys: phase=${phase}, dryRun=${dryRun}, batchSize=${options.batchSize ?? 1000}, limit=${options.limit ?? 'none'}, afterId=${options.afterId ?? 0}`,
  );

  for (const currentPhase of phasesToRun) {
    const phaseOptions = phase === 'all' ? { ...options, afterId: 0, limit: undefined } : options;

    if (currentPhase === 'backfill-orders') {
      const remaining = await countRemaining(db, 'Orders', phaseOptions.afterId ?? 0);
      logger.info(`Starting backfill-orders (${remaining} rows remaining)...`);
      results['backfill-orders'] = await runPaginatedTableUpdate({
        db,
        table: 'Orders',
        mode: 'backfill',
        phaseName: 'backfill-orders',
        totalRemaining: remaining,
        options: phaseOptions,
      });
      logPhaseSummary('backfill-orders', results['backfill-orders'], dryRun);
      continue;
    }

    if (currentPhase === 'backfill-expenses') {
      const remaining = await countRemaining(db, 'Expenses', phaseOptions.afterId ?? 0);
      logger.info(`Starting backfill-expenses (${remaining} rows remaining)...`);
      results['backfill-expenses'] = await runPaginatedTableUpdate({
        db,
        table: 'Expenses',
        mode: 'backfill',
        phaseName: 'backfill-expenses',
        totalRemaining: remaining,
        options: phaseOptions,
      });
      logPhaseSummary('backfill-expenses', results['backfill-expenses'], dryRun);
      continue;
    }

    if (currentPhase === 'remove-legacy-orders') {
      const remaining = await countRemaining(db, 'Orders', phaseOptions.afterId ?? 0);
      logger.info(`Starting remove-legacy-orders (${remaining} rows remaining)...`);
      results['remove-legacy-orders'] = await runPaginatedTableUpdate({
        db,
        table: 'Orders',
        mode: 'remove',
        phaseName: 'remove-legacy-orders',
        totalRemaining: remaining,
        options: phaseOptions,
      });
      logPhaseSummary('remove-legacy-orders', results['remove-legacy-orders'], dryRun);
      continue;
    }

    if (currentPhase === 'remove-legacy-expenses') {
      const remaining = await countRemaining(db, 'Expenses', phaseOptions.afterId ?? 0);
      logger.info(`Starting remove-legacy-expenses (${remaining} rows remaining)...`);
      results['remove-legacy-expenses'] = await runPaginatedTableUpdate({
        db,
        table: 'Expenses',
        mode: 'remove',
        phaseName: 'remove-legacy-expenses',
        totalRemaining: remaining,
        options: phaseOptions,
      });
      logPhaseSummary('remove-legacy-expenses', results['remove-legacy-expenses'], dryRun);
      continue;
    }

    if (currentPhase === 'drop-indexes') {
      logger.info('Starting drop-indexes...');
      if (!dryRun) {
        logger.info('drop-indexes: dropping orders__data__payment_intent_id...');
        await db.query(`DROP INDEX CONCURRENTLY IF EXISTS "orders__data__payment_intent_id"`);
        logger.info('drop-indexes: dropping expenses__data__payment_intent_id...');
        await db.query(`DROP INDEX CONCURRENTLY IF EXISTS "expenses__data__payment_intent_id"`);
        logger.info('drop-indexes: indexes dropped');
      } else {
        logger.info('drop-indexes: would drop orders__data__payment_intent_id and expenses__data__payment_intent_id');
      }
      results['drop-indexes'] = { processed: 0, lastId: 0, complete: true };
      logPhaseSummary('drop-indexes', results['drop-indexes'], dryRun);
    }
  }

  return results;
};

const main = async (): Promise<void> => {
  const program = new Command();
  program
    .option('--phase <name>', 'Phase to run', 'all')
    .option('--batch-size <n>', 'Rows per batch', parseInt)
    .option('--limit <n>', 'Max rows to process in this run', parseInt)
    .option('--after-id <n>', 'Resume cursor (id > after-id)', parseInt)
    .parse();

  const options = program.opts();
  const dryRun = process.env.DRY_RUN !== 'false';
  const phase = options.phase as RemoveLegacyJsonKeysPhase;
  const validPhases: RemoveLegacyJsonKeysPhase[] = [...PHASES, 'all'];

  if (!validPhases.includes(phase)) {
    logger.error(`Invalid phase: ${phase}. Expected one of: ${validPhases.join(', ')}`);
    process.exit(1);
  }

  if (dryRun) {
    logger.info('Running in DRY RUN mode');
  }

  await runRemoveLegacyJsonKeys(sequelize, phase, {
    dryRun,
    batchSize: options.batchSize,
    limit: options.limit,
    afterId: options.afterId,
  });
};

if (!module.parent) {
  main()
    .then(() => process.exit())
    .catch(error => {
      logger.error(error);
      process.exit(1);
    });
}
