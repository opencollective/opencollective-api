#!/usr/bin/env node
import '../../server/env';

import { sequelize } from '../../server/models';

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

cleanStaleExpenseDrafts();
