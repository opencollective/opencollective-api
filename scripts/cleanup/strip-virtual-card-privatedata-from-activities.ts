/**
 * Remove decrypted virtual-card privateData from Activities.data JSONB.
 *
 * Usage:
 *   # Preview the first 500 matching activities (default)
 *   npm run script scripts/cleanup/strip-virtual-card-privatedata-from-activities.ts
 *
 *   # Update up to 500 activities; rerun to continue
 *   DRY_RUN=false npm run script scripts/cleanup/strip-virtual-card-privatedata-from-activities.ts
 *
 *   # Update up to 5,000 activities in batches of 500
 *   DRY_RUN=false npm run script scripts/cleanup/strip-virtual-card-privatedata-from-activities.ts -- --batch-size 500 --limit 5000
 *
 *   # Resume a preview or update after a specific activity ID
 *   DRY_RUN=false npm run script scripts/cleanup/strip-virtual-card-privatedata-from-activities.ts -- --after-id 5000000
 */

import '../../server/env';

import { Command } from 'commander';
import { QueryTypes } from 'sequelize';

import ActivityTypes from '../../server/constants/activities';
import logger from '../../server/lib/logger';
import { parseToBoolean } from '../../server/lib/utils';
import { sequelize } from '../../server/models';

// Include historical activity types, since their snapshots may still exist in Activities.
const VIRTUAL_CARD_ACTIVITY_TYPES = [
  ActivityTypes.COLLECTIVE_VIRTUAL_CARD_ADDED,
  ActivityTypes.COLLECTIVE_VIRTUAL_CARD_ASSIGNED,
  ActivityTypes.COLLECTIVE_VIRTUAL_CARD_CREATED,
  ActivityTypes.COLLECTIVE_VIRTUAL_CARD_MISSING_RECEIPTS,
  ActivityTypes.COLLECTIVE_VIRTUAL_CARD_RESUMED,
  ActivityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED,
  ActivityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED_DUE_TO_INACTIVITY,
  ActivityTypes.COLLECTIVE_VIRTUAL_CARD_DELETED,
  ActivityTypes.COLLECTIVE_VIRTUAL_CARD_REQUEST_APPROVED,
  ActivityTypes.COLLECTIVE_VIRTUAL_CARD_REQUEST_REJECTED,
  ActivityTypes.VIRTUAL_CARD_REQUESTED,
  ActivityTypes.VIRTUAL_CARD_CHARGE_DECLINED,
  ActivityTypes.VIRTUAL_CARD_PURCHASE,
];

const BATCH_SIZE = 500;

const CANDIDATE_IDS_QUERY = `
  SELECT id
  FROM "Activities"
  WHERE id > :afterId
    AND type IN (:activityTypes)
    AND data->'virtualCard' ? 'privateData'
  ORDER BY id
  LIMIT :batchSize
`;

const UPDATE_QUERY = `
  UPDATE "Activities"
  SET data = data #- '{virtualCard,privateData}'::text[]
  WHERE id IN (${CANDIDATE_IDS_QUERY})
  RETURNING id
`;

export async function run({
  dryRun = process.env.DRY_RUN ? parseToBoolean(process.env.DRY_RUN) : true,
  batchSize = BATCH_SIZE,
  limit = batchSize,
  afterId = 0,
}: { dryRun?: boolean; batchSize?: number; limit?: number; afterId?: number } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error('batchSize must be a positive integer');
  }

  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer');
  }

  if (!Number.isSafeInteger(afterId) || afterId < 0) {
    throw new Error('afterId must be a non-negative integer');
  }

  let processed = 0;
  let lastId = afterId;

  while (processed < limit) {
    const pageSize = Math.min(batchSize, limit - processed);
    const rows = await sequelize.query<{ id: number }>(dryRun ? CANDIDATE_IDS_QUERY : UPDATE_QUERY, {
      replacements: {
        activityTypes: VIRTUAL_CARD_ACTIVITY_TYPES,
        afterId: lastId,
        batchSize: pageSize,
      },
      type: QueryTypes.SELECT,
    });

    if (rows.length === 0) {
      break;
    }

    processed += rows.length;
    lastId = rows.reduce((maxId, row) => Math.max(maxId, row.id), lastId);
    logger.info(
      `${dryRun ? 'Would scrub' : 'Scrubbed'} ${rows.length} activities (total=${processed}, lastId=${lastId})`,
    );

    if (rows.length < pageSize) {
      break;
    }
  }

  logger.info(`${dryRun ? 'Would scrub' : 'Scrubbed'} ${processed} activities in this run (lastId=${lastId})`);
  return { processed, lastId };
}

if (require.main === module) {
  const program = new Command();
  program
    .option('--batch-size <n>', 'Maximum rows per batch', Number)
    .option('--limit <n>', 'Maximum rows to process in this run', Number)
    .option('--after-id <n>', 'Only process activities with an ID greater than this', Number)
    .parse();

  run(program.opts())
    .then(() => process.exit(0))
    .catch(e => {
      logger.error(e);
      process.exit(1);
    });
}
