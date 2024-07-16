import config from 'config';
import deepmerge from 'deepmerge';

import logger from '../server/lib/logger';
import { lockUntilOrThrow } from '../server/lib/mutex';
import { closeRedisClient } from '../server/lib/redis';
import { CaptureErrorParams, reportErrorToSentry } from '../server/lib/sentry';
import { sleep } from '../server/lib/utils';
import { sequelize } from '../server/models';

/**
 * Heroku scheduler only has daily or hourly cron jobs, we only want to run
 * this script once per week on Monday (1). If the day is not Monday on production
 * we won't execute the script
 */
export function onlyExecuteInProdOnMondays() {
  const today = new Date();
  if (config.env === 'production' && today.getDay() !== 1) {
    logger.warn('OC_ENV is production and day is not Monday, script aborted!');
    process.exit(0);
  }
}

export const runCronJob = async (
  name: string,
  run: () => Promise<any>,
  timeoutMs: number,
  errorParameters?: CaptureErrorParams,
) => {
  let exitCode = 0;
  if (require.main !== module && process.env.DISABLE_CRON_MODULE_START_CHECK === undefined) {
    logger.warn('This script is not meant to be required, please run it directly');
    return;
  }

  try {
    await lockUntilOrThrow(
      `cron:${name}`,
      async () => {
        const start = Date.now();
        logger.info(`Starting CRON job: ${name}`);
        await run();
        const duration = Date.now() - start;
        logger.info(`CRON job finished in ${Math.round(duration / 1000)}s: ${name} `);
      },
      {
        unlockTimeoutMs: timeoutMs * 1000,
      },
    );
  } catch (error) {
    logger.error(`Error running ${name} job`, error);
    reportErrorToSentry(
      error,
      deepmerge({ handler: 'CRON', extra: { name, timeout: timeoutMs } }, errorParameters || {}),
    );
    // Await for Sentry to finish sending the error
    await sleep(1000);
    exitCode = 1;
  }

  const isNotTest = process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'ci' && config.env !== 'e2e';
  if (isNotTest) {
    await closeRedisClient();
    await sequelize.close();
    process.exit(exitCode);
  } else {
    logger.info(`CRON would exit with code ${exitCode}`);
  }
};
