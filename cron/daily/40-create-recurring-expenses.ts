import '../../server/env';

import models, { sequelize } from '../../server/models';

const DRY = process.env.DRY !== 'false';
if (DRY) {
  console.info('Running dry, changes are not going to be persisted to the DB.');
}

const run = async () => {
  const recurringExpensesDue = await models.RecurringExpense.getRecurringExpensesDue();
  console.log(`Found ${recurringExpensesDue.length} recurring expenses due.`);
  for (const recurringExpense of recurringExpensesDue) {
    console.log(
      `\nRecurringExpense #${recurringExpense.id} (${recurringExpense.interval}): Last time paid ${recurringExpense.lastDraftedAt}`,
    );
    if (!DRY) {
      await recurringExpense.createNextExpense().catch(e => {
        console.error(`Error creating recurring expense #${recurringExpense.id}:`, e);
      });
    }
  }
};

if (require.main === module) {
  run()
    .catch(e => {
      console.error(e);
      process.exit(1);
    })
    .then(() => {
      setTimeout(() => sequelize.close(), 2000);
    });
}
