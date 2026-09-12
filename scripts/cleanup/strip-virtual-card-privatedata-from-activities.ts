/**
 * Remove decrypted virtual-card privateData from Activities.data JSONB.
 *
 * Usage:
 *   # Dry run (default)
 *   npm run script scripts/cleanup/strip-virtual-card-privatedata-from-activities.ts
 *
 *   # Apply
 *   DRY_RUN=false npm run script scripts/cleanup/strip-virtual-card-privatedata-from-activities.ts
 */

import '../../server/env';

import { QueryTypes } from 'sequelize';

import logger from '../../server/lib/logger';
import { parseToBoolean } from '../../server/lib/utils';
import { sequelize } from '../../server/models';

const DRY_RUN = process.env.DRY_RUN ? parseToBoolean(process.env.DRY_RUN) : true;

const COUNT_QUERY = `
  SELECT COUNT(*)::int AS count
  FROM "Activities"
  WHERE data->'virtualCard' ? 'privateData'
`;

const UPDATE_QUERY = `
  UPDATE "Activities"
  SET data = jsonb_set(data, '{virtualCard}', data->'virtualCard' - 'privateData')
  WHERE data->'virtualCard' ? 'privateData'
`;

async function run() {
  const countRows = await sequelize.query<{ count: number }>(COUNT_QUERY, { type: QueryTypes.SELECT });
  const count = countRows[0]?.count ?? 0;

  logger.info(`Found ${count} activities with data.virtualCard.privateData`);

  if (count === 0) {
    return;
  }

  if (DRY_RUN) {
    logger.info('DRY_RUN=true — no rows updated. Set DRY_RUN=false to apply.');
    return;
  }

  const metadata = await sequelize.query(UPDATE_QUERY, { type: QueryTypes.UPDATE });
  logger.info(`Scrubbed privateData from ${count} activities (update result: ${metadata})`);
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(e => {
      logger.error(e);
      process.exit(1);
    });
}
