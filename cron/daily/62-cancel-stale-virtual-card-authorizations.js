import '../../server/env';

import { sequelize } from '../../server/models';

const cancelPendingChargeExpenseAuthorizations = async () => {
  console.log('Canceling pending Charge Expense authorizations older than 1 week...');

  const [, meta] = await sequelize.query(
    `
    UPDATE "Expenses"
    SET "status" = 'CANCELED'
    WHERE "deletedAt" IS NULL
      AND "type" = 'CHARGE'
      AND "status" = 'PROCESSING'
      AND "data"->>'authorizationId' IS NOT NULL
      AND "createdAt" < NOW() - interval '1 week';
    `,
  );

  console.log(`>>> Done: ${meta?.rowCount} charge expenses canceled.`);
  process.exit(0);
};

cancelPendingChargeExpenseAuthorizations();
