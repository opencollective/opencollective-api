import '../../server/env';

import { sequelize } from '../../server/models';
import { runCronJob } from '../utils';

const cleanStaleExpenseDrafts = async () => {
  console.log('Cleaning Expense drafts older than 1 month...');

  const [, meta] = await sequelize.query(
    `
    UPDATE "Expenses"
    SET "deletedAt" = NOW()
    WHERE "deletedAt" IS NULL
    AND ("status" = 'DRAFT' OR "status" = 'UNVERIFIED')
    AND "updatedAt" <= (NOW() - interval '2 month');
    `,
  );

  console.log(`>>> Done: ${meta?.rowCount} draft(s) deleted.`);
  process.exit(0);
};

if (require.main === module) {
  runCronJob('clean-stale-expense-drafts', cleanStaleExpenseDrafts, 24 * 60 * 60);
}
