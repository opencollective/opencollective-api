import '../../server/env';

import { sequelize } from '../../server/models';
import { runCronJob } from '../utils';

/** pg returns the number of affected rows as the second element of the result tuple */
type UpdateResult = [unknown[], { rowCount: number }];

const cleanStaleExpenseDrafts = async (): Promise<void> => {
  console.log('Cleaning Expense drafts older than 1 month...');

  const [, meta] = (await sequelize.query(
    `
    UPDATE "Expenses"
    SET "deletedAt" = NOW()
    WHERE "deletedAt" IS NULL
    AND ("status" = 'DRAFT' OR "status" = 'UNVERIFIED')
    AND "updatedAt" <= (NOW() - interval '2 month');
    `,
  )) as UpdateResult;

  console.log(`>>> Done: ${meta?.rowCount} draft(s) deleted.`);
};

if (require.main === module) {
  runCronJob('clean-stale-expense-drafts', cleanStaleExpenseDrafts, 24 * 60 * 60);
}
