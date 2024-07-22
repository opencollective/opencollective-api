import '../../server/env';

import logger from '../../server/lib/logger';
import { reportErrorToSentry } from '../../server/lib/sentry';
import models from '../../server/models';
import { runCronJob } from '../utils';

const run = async () => {
  const recurringExpensesDue = await models.RecurringExpense.getRecurringExpensesDue();
  logger.info(`Found ${recurringExpensesDue.length} recurring expenses due.`);
  for (const recurringExpense of recurringExpensesDue) {
    logger.info(
      `\nRecurringExpense #${recurringExpense.id} (${recurringExpense.interval}): Last time paid ${recurringExpense.lastDraftedAt}`,
    );
    await recurringExpense.createNextExpense().catch(e => {
      logger.error(`Error creating recurring expense #${recurringExpense.id}:`, e);
      reportErrorToSentry(e);
    });
  }
};

if (require.main === module) {
  runCronJob('make-updates-public', run, 24 * 60 * 60);
}
