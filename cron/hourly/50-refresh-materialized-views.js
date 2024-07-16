import '../../server/env';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';
import { runCronJob } from '../utils';

const VIEWS = [
  'CollectiveTransactionStats',
  'TransactionBalances',
  'CollectiveBalanceCheckpoint',
  'CollectiveOrderStats',
  'CollectiveTagStats',
  'ExpenseTagStats',
];

const VIEWS_WITHOUT_UNIQUE_INDEX = ['HostMonthlyTransactions'];

/**
 * Refresh the materialized views.
 *
 * `CONCURRENTLY` is used to avoid deadlocks, as Postgres otherwise lock queries
 * using this table until the refresh is complete.
 */
async function run() {
  for (const view of VIEWS) {
    logger.info(`Refreshing ${view} materialized view CONCURRENTLY...`);
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

  for (const view of VIEWS_WITHOUT_UNIQUE_INDEX) {
    logger.info(`Refreshing ${view} materialized view...`);
    const startTime = process.hrtime();
    try {
      await sequelize.query(`REFRESH MATERIALIZED VIEW "${view}"`);
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

runCronJob('refresh-materialized-views', run, 60 * 60 * 1000);
