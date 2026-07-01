/**
 * Strip bloated collective.data snapshots from Collectives and Activities JSONB columns.
 *
 * Usage:
 *   # Dry run (default)
 *   npm run script scripts/cleanup/strip-collective-data-from-jsonb.ts
 *
 *   # Apply all phases
 *   DRY_RUN=false npm run script scripts/cleanup/strip-collective-data-from-jsonb.ts
 *
 *   # Resume / partial
 *   DRY_RUN=false npm run script scripts/cleanup/strip-collective-data-from-jsonb.ts -- --phase activities --after-id 5000000 --limit 10000
 */

import '../../server/env';

import { Command } from 'commander';
import type { Sequelize } from 'sequelize';

import {
  cleanupActivityDataJsonb,
  cleanupCollectiveDataJsonb,
  jsonbSize,
} from '../../server/lib/cleanup/strip-collective-data-from-jsonb';
import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

type StripCollectiveDataPhase = 'collectives' | 'activities' | 'all';

type StripCollectiveDataOptions = {
  dryRun?: boolean;
  batchSize?: number;
  limit?: number;
  afterId?: number;
  sizeThreshold?: number;
};

type PhaseStats = {
  processed: number;
  updated: number;
  bytesSaved: number;
  lastId: number;
  complete: boolean;
};

const DEFAULT_SIZE_THRESHOLD = 10_000;

const COLLECTIVES_WHERE = `
  data ? 'spamReport'
  OR data ? 'data'
  OR octet_length(data::text) > :sizeThreshold
`;

const ACTIVITIES_WHERE = `
  data->'collective' ? 'data'
  OR data->'previousData' ? 'data'
  OR data->'newData' ? 'data'
  OR data->'host' ? 'data'
  OR data->'fromCollective' ? 'data'
  OR data->'toCollective' ? 'data'
  OR data->'movedFromCollective' ? 'data'
  OR octet_length(data::text) > :sizeThreshold
`;

const countRemaining = async (
  db: Sequelize,
  table: 'Collectives' | 'Activities',
  afterId: number,
  sizeThreshold: number,
): Promise<number> => {
  const whereClause = table === 'Collectives' ? COLLECTIVES_WHERE : ACTIVITIES_WHERE;

  const [rows] = (await db.query(
    `
      SELECT COUNT(*)::int AS count
      FROM "${table}"
      WHERE id > :afterId
        AND (${whereClause});
    `,
    { replacements: { afterId, sizeThreshold } },
  )) as [{ count: number }[], unknown];

  return rows[0]?.count ?? 0;
};

const runCollectivesPhase = async (db: Sequelize, options: StripCollectiveDataOptions): Promise<PhaseStats> => {
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? 500;
  const limit = options.limit;
  const sizeThreshold = options.sizeThreshold ?? DEFAULT_SIZE_THRESHOLD;
  let afterId = options.afterId ?? 0;
  let processed = 0;
  let updated = 0;
  let bytesSaved = 0;

  while (true) {
    if (limit !== undefined && processed >= limit) {
      break;
    }

    const effectiveBatchSize = limit !== undefined ? Math.min(batchSize, limit - processed) : batchSize;

    const [rows] = (await db.query(
      `
        SELECT id, data
        FROM "Collectives"
        WHERE id > :afterId
          AND (${COLLECTIVES_WHERE})
        ORDER BY id ASC
        LIMIT :batchSize;
      `,
      {
        replacements: { afterId, batchSize: effectiveBatchSize, sizeThreshold },
      },
    )) as [{ id: number; data: Record<string, unknown> }[], unknown];

    if (rows.length === 0) {
      return { processed, updated, bytesSaved, lastId: afterId, complete: true };
    }

    for (const row of rows) {
      processed++;
      afterId = row.id;
      const beforeSize = jsonbSize(row.data);
      const newData = cleanupCollectiveDataJsonb(row.data);
      const afterSize = jsonbSize(newData);
      const saved = beforeSize - afterSize;

      if (saved > 0) {
        updated++;
        bytesSaved += saved;

        if (!dryRun) {
          await db.query(`UPDATE "Collectives" SET data = :newData WHERE id = :id`, {
            replacements: { id: row.id, newData: JSON.stringify(newData) },
          });
        }

        if (saved > 1000) {
          logger.info(
            `collectives: id=${row.id} ${dryRun ? 'would save' : 'saved'} ${saved} bytes (${beforeSize} -> ${afterSize})`,
          );
        }
      }
    }

    logger.info(
      `collectives: batch processed ${rows.length} rows (total=${processed}, updated=${updated}, bytesSaved=${bytesSaved}, lastId=${afterId})`,
    );
  }

  return { processed, updated, bytesSaved, lastId: afterId, complete: limit === undefined };
};

const runActivitiesPhase = async (db: Sequelize, options: StripCollectiveDataOptions): Promise<PhaseStats> => {
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? 500;
  const limit = options.limit;
  const sizeThreshold = options.sizeThreshold ?? DEFAULT_SIZE_THRESHOLD;
  let afterId = options.afterId ?? 0;
  let processed = 0;
  let updated = 0;
  let bytesSaved = 0;

  while (true) {
    if (limit !== undefined && processed >= limit) {
      break;
    }

    const effectiveBatchSize = limit !== undefined ? Math.min(batchSize, limit - processed) : batchSize;

    const [rows] = (await db.query(
      `
        SELECT id, data
        FROM "Activities"
        WHERE id > :afterId
          AND (${ACTIVITIES_WHERE})
        ORDER BY id ASC
        LIMIT :batchSize;
      `,
      {
        replacements: { afterId, batchSize: effectiveBatchSize, sizeThreshold },
      },
    )) as [{ id: number; data: Record<string, unknown> }[], unknown];

    if (rows.length === 0) {
      return { processed, updated, bytesSaved, lastId: afterId, complete: true };
    }

    for (const row of rows) {
      processed++;
      afterId = row.id;
      const beforeSize = jsonbSize(row.data);
      const newData = cleanupActivityDataJsonb(row.data);
      const afterSize = jsonbSize(newData);
      const saved = beforeSize - afterSize;

      if (saved > 0) {
        updated++;
        bytesSaved += saved;

        if (!dryRun) {
          await db.query(`UPDATE "Activities" SET data = :newData WHERE id = :id`, {
            replacements: { id: row.id, newData: JSON.stringify(newData) },
          });
        }

        if (saved > 1000) {
          logger.info(
            `activities: id=${row.id} ${dryRun ? 'would save' : 'saved'} ${saved} bytes (${beforeSize} -> ${afterSize})`,
          );
        }
      }
    }

    logger.info(
      `activities: batch processed ${rows.length} rows (total=${processed}, updated=${updated}, bytesSaved=${bytesSaved}, lastId=${afterId})`,
    );
  }

  return { processed, updated, bytesSaved, lastId: afterId, complete: limit === undefined };
};

export const runStripCollectiveDataFromJsonb = async (
  db: Sequelize,
  phase: StripCollectiveDataPhase,
  options: StripCollectiveDataOptions = {},
): Promise<Record<string, PhaseStats>> => {
  const dryRun = options.dryRun ?? false;
  const sizeThreshold = options.sizeThreshold ?? DEFAULT_SIZE_THRESHOLD;
  const results: Record<string, PhaseStats> = {};
  const phasesToRun: StripCollectiveDataPhase[] = phase === 'all' ? ['collectives', 'activities'] : [phase];

  logger.info(
    `strip-collective-data-from-jsonb: phase=${phase}, dryRun=${dryRun}, batchSize=${options.batchSize ?? 500}, limit=${options.limit ?? 'none'}, afterId=${options.afterId ?? 0}, sizeThreshold=${sizeThreshold}`,
  );

  for (const currentPhase of phasesToRun) {
    const phaseOptions = phase === 'all' ? { ...options, afterId: 0, limit: undefined } : options;
    const remaining = await countRemaining(
      db,
      currentPhase === 'collectives' ? 'Collectives' : 'Activities',
      phaseOptions.afterId ?? 0,
      sizeThreshold,
    );

    logger.info(`Starting ${currentPhase} (${remaining} rows remaining)...`);

    if (currentPhase === 'collectives') {
      results.collectives = await runCollectivesPhase(db, phaseOptions);
      logger.info(
        `${currentPhase}: processed=${results.collectives.processed}, updated=${results.collectives.updated}, bytesSaved=${results.collectives.bytesSaved}, lastId=${results.collectives.lastId}, complete=${results.collectives.complete}`,
      );
    } else {
      results.activities = await runActivitiesPhase(db, phaseOptions);
      logger.info(
        `${currentPhase}: processed=${results.activities.processed}, updated=${results.activities.updated}, bytesSaved=${results.activities.bytesSaved}, lastId=${results.activities.lastId}, complete=${results.activities.complete}`,
      );
    }
  }

  return results;
};

const main = async (): Promise<void> => {
  const program = new Command();
  program
    .option('--phase <name>', 'Phase to run: collectives, activities, or all', 'all')
    .option('--batch-size <n>', 'Rows per batch', parseInt)
    .option('--limit <n>', 'Max rows to process in this run', parseInt)
    .option('--after-id <n>', 'Resume cursor (id > after-id)', parseInt)
    .option('--size-threshold <n>', 'octet_length threshold for large JSONB rows', parseInt)
    .parse();

  const options = program.opts();
  const dryRun = process.env.DRY_RUN !== 'false';
  const phase = options.phase as StripCollectiveDataPhase;
  const validPhases: StripCollectiveDataPhase[] = ['collectives', 'activities', 'all'];

  if (!validPhases.includes(phase)) {
    logger.error(`Invalid phase: ${phase}. Expected one of: ${validPhases.join(', ')}`);
    process.exit(1);
  }

  if (dryRun) {
    logger.info('Running in DRY RUN mode');
  }

  await runStripCollectiveDataFromJsonb(sequelize, phase, {
    dryRun,
    batchSize: options.batchSize,
    limit: options.limit,
    afterId: options.afterId,
    sizeThreshold: options.sizeThreshold,
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
