import '../../server/env';

import logger from '../../server/lib/logger';
import { reportMessageToSentry } from '../../server/lib/sentry';
import models from '../../server/models';
import { runCronJob } from '../utils';

const run = async () => {
  const [, nbUpdated] = await models.Order.clearExpiredLocks();
  if (nbUpdated > 0) {
    logger.warn(`clearExpiredLocks: ${nbUpdated} expired locks cleared`);
    reportMessageToSentry(`clearExpiredLocks: ${nbUpdated} expired locks cleared`, {
      severity: 'warning',
      handler: 'CRON',
      extra: { date: new Date() },
    });
  }
};

if (require.main === module) {
  runCronJob('clear-expired-locks', run, 60 * 60);
}
