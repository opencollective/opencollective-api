import { parseArgs } from 'node:util';

import logger from '../../server/lib/logger';

const parseOptions = () => {
  const { values } = parseArgs({
    options: {
      fix: {
        type: 'boolean',
        default: false,
      },
    },
  });

  return values;
};

export type CheckFn = (options: { fix: boolean }) => Promise<void>;

export const runAllChecks = async (checks: CheckFn[]): Promise<Error[]> => {
  const errors = [];
  const options = parseOptions();
  for (const check of checks) {
    try {
      const start = performance.now();
      await check(options);
      logger.info(`Checked: ${check.name} (${Math.round(performance.now() - start)}ms)`);
    } catch (error) {
      errors.push(error);
    }
  }

  return errors;
};

export const logChecksErrors = (errors: Error[]): void => {
  logger.info('----------------------------------------');
  if (!errors.length) {
    logger.info('All checks passed!');
  } else {
    logger.error(`${errors.length} ${errors.length === 1 ? 'check' : 'checks'} failed:`);
    for (const error of errors) {
      logger.error(`- ${error.message}`);
    }
  }
};

export const runAllChecksThenExit = async (checks: CheckFn[]): Promise<void> => {
  const errors = await runAllChecks(checks);
  logChecksErrors(errors);
  process.exit(errors.length ? 1 : 0);
};
