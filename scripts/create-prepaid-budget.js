#!/usr/bin/env node
import '../server/env.js';

import { createPrepaidPaymentMethod } from '../server/lib/prepaid-budget.js';
import models, { sequelize } from '../server/models/index.js';

async function run() {
  if (process.argv.length < 3) {
    console.error('Usage: npm run script ./scripts/create-prepaid-budget.js TRANSACTION_ID');
    process.exit(1);
  }

  const TRANSACTION_ID = process.argv[2];

  const originalCreditTransaction = await models.Transaction.findByPk(TRANSACTION_ID);
  if (originalCreditTransaction) {
    await createPrepaidPaymentMethod(originalCreditTransaction);
  } else {
    console.log('Could not find original credit transaction.');
  }

  await sequelize.close();
}

run();
