import '../../server/env';

import logger from '../../server/lib/logger';
import models, { sequelize } from '../../server/models';

const DRY = process.env.DRY !== 'false';
if (DRY) {
  logger.info('Running dry, changes are not going to be persisted to the DB.');
}

const run = async () => {
  const recurringExpensesDue = await models.RecurringExpense.getRecurringExpensesDue();
  logger.info(`Found ${recurringExpensesDue.length} recurring expenses due.`);
  for (const recurringExpense of recurringExpensesDue) {
    logger.info(
      `\nRecurringExpense #${recurringExpense.id} (${recurringExpense.interval}): Last time paid ${recurringExpense.lastDraftedAt}`,
    );
    if (!DRY) {
      await recurringExpense.createNextExpense().catch(e => {
        logger.error(`Error creating recurring expense #${recurringExpense.id}:`, e);
      });
    }
  }
};

if (require.main === module) {
  run()
    .catch(e => {
      logger.error(e);
      process.exit(1);
    })
    .then(() => {
      setTimeout(() => sequelize.close(), 2000);
    });
}
