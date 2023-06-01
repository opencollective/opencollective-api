#!/usr/bin/env node

import '../../server/env';

import logger from '../../server/lib/logger';
import { reportErrorToSentry } from '../../server/lib/sentry';
import { sequelize } from '../../server/models';

/**
 * Refresh the collective stats materialized view.
 *
 * `CONCURRENTLY` is used to avoid deadlocks, as Postgres otherwise lock queries
 * using this table until the refresh is complete.
 */
export async function run() {
  logger.info('Refreshing CollectiveTransactionStats materialized view...');
  const startTime = process.hrtime();
  await sequelize.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY "CollectiveTransactionStats"`);
  const [runSeconds, runMilliSeconds] = process.hrtime(startTime);
  logger.info(`CollectiveTransactionStats materialized view refreshed in ${runSeconds}.${runMilliSeconds} seconds`);
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(e => {
      console.error(e);
      reportErrorToSentry(e);
      process.exit(1);
    });
}
