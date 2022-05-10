#!/usr/bin/env node

import '../../server/env';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

/**
 * Refresh the collective stats materialized view.
 *
 * `CONCURRENTLY` is used to avoid deadlocks, as Postgres otherwise lock queries
 * using this table until the refresh is complete.
 */
export async function run() {
  logger.info('Refreshing CollectiveStats materialized view...');
  const startTime = process.hrtime();
  await sequelize.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY "CollectiveStats"`);
  const [runSeconds, runMilliSeconds] = process.hrtime(startTime);
  logger.info(`CollectiveStats materialized view refreshed in ${runSeconds}.${runMilliSeconds} seconds`);
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
