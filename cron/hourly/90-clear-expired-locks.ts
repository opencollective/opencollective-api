import '../../server/env';

import logger from '../../server/lib/logger';
import { reportErrorToSentry, reportMessageToSentry } from '../../server/lib/sentry';
import models from '../../server/models';

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
  run()
    .then(() => process.exit(0))
    .catch(e => {
      console.error(e);
      reportErrorToSentry(e, { handler: 'CRON' });
      process.exit(1);
    });
}
