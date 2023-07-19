#!/usr/bin/env node

import '../../server/env.js';

import logger from '../../server/lib/logger.js';
import { reportErrorToSentry } from '../../server/lib/sentry.js';
import { sequelize } from '../../server/models/index.js';

const VIEWS = [
  'CollectiveTransactionStats',
  'TransactionBalances',
  'CollectiveBalanceCheckpoint',
  'CollectiveOrderStats',
];

/**
 * Refresh the materialized views.
 *
 * `CONCURRENTLY` is used to avoid deadlocks, as Postgres otherwise lock queries
 * using this table until the refresh is complete.
 */
export async function run() {
  for (const view of VIEWS) {
    logger.info(`Refreshing ${view} materialized view...`);
    const startTime = process.hrtime();
    try {
      await sequelize.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY "${view}"`);
      const [runSeconds, runMilliSeconds] = process.hrtime(startTime);
      logger.info(`${view} materialized view refreshed in ${runSeconds}.${runMilliSeconds} seconds`);
    } catch (e) {
      const [runSeconds, runMilliSeconds] = process.hrtime(startTime);
      logger.error(
        `Error while refreshing ${view} materialized view after ${runSeconds}.${runMilliSeconds} seconds: ${e.message}`,
        e,
      );
    }
  }
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
