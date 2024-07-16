import config from 'config';

import { lockUntilOrThrow } from '../server/lib/mutex';
import { closeRedisClient } from '../server/lib/redis';
import { reportErrorToSentry } from '../server/lib/sentry';
import { sequelize } from '../server/models';

/**
 * Heroku scheduler only has daily or hourly cron jobs, we only want to run
 * this script once per week on Monday (1). If the day is not Monday on production
 * we won't execute the script
 */
export function onlyExecuteInProdOnMondays() {
  const today = new Date();
  if (config.env === 'production' && today.getDay() !== 1) {
    console.log('OC_ENV is production and day is not Monday, script aborted!');
    process.exit(0);
  }
}

export const runCronJob = async (name: string, run: () => Promise<any>, timeoutMs: number) => {
  let exitCode = 0;
  const isNotTest = process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'ci' && config.env !== 'e2e';
  if (require.main !== module && isNotTest) {
    console.warn('This script is not meant to be required, please run it directly');
    return;
  }

  try {
    await lockUntilOrThrow(`cron:${name}`, run, {
      unlockTimeoutMs: timeoutMs,
    });
  } catch (error) {
    console.error(`Error running ${name} job`, error);
    await reportErrorToSentry(error, { handler: 'CRON', extra: { name, timeout: timeoutMs } });
    exitCode = 1;
  } finally {
    if (isNotTest) {
      await closeRedisClient();
      await sequelize.close();
      process.exit(exitCode);
    } else {
      console.info(`Cron would exit with code ${exitCode}`);
    }
  }
};
