#!/usr/bin/env node

import '../../server/env.js';

import logger from '../../server/lib/logger.js';
import { reportErrorToSentry } from '../../server/lib/sentry.js';
import { sequelize } from '../../server/models/index.js';

/**
 * Refresh the collective tag stats materialized view.
 *
 * `CONCURRENTLY` is used to avoid deadlocks, as Postgres otherwise lock queries
 * using this table until the refresh is complete.
 */
export async function run() {
  logger.info('Refreshing CollectiveTagStats materialized view...');
  const startTime = process.hrtime();
  await sequelize.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY "CollectiveTagStats"`);
  const [runSeconds, runMilliSeconds] = process.hrtime(startTime);
  logger.info(`CollectiveTagStats materialized view refreshed in ${runSeconds}.${runMilliSeconds} seconds`);
}

import { pathToFileURL } from 'url';

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .then(() => process.exit(0))
    .catch(e => {
      console.error(e);
      reportErrorToSentry(e);
      process.exit(1);
    });
}
