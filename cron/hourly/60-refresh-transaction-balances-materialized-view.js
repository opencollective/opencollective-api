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
  logger.info('Refreshing TransactionBalances materialized view...');
  const startTime = process.hrtime();
  await sequelize.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY "TransactionBalances"`);
  const [runSeconds, runMilliSeconds] = process.hrtime(startTime);
  logger.info(`TransactionBalances materialized view refreshed in ${runSeconds}.${runMilliSeconds} seconds`);

  logger.info('Refreshing CollectiveBalanceCheckpoint materialized view...');
  const startTimeLb = process.hrtime();
  await sequelize.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY "CollectiveBalanceCheckpoint"`);
  const [runSecondsLb, runMilliSecondsLb] = process.hrtime(startTimeLb);
  logger.info(
    `CollectiveBalanceCheckpoint materialized view refreshed in ${runSecondsLb}.${runMilliSecondsLb} seconds`,
  );
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
