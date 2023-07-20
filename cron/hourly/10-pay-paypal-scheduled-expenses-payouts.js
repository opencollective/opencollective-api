#!/usr/bin/env node

import '../../server/env.js';

import { groupBy, values } from 'lodash-es';

import status from '../../server/constants/expense_status.js';
import logger from '../../server/lib/logger.js';
import { reportErrorToSentry } from '../../server/lib/sentry.js';
import models from '../../server/models/index.js';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod.js';
import * as paypal from '../../server/paymentProviders/paypal/payouts.js';

export async function run() {
  const expenses = await models.Expense.findAll({
    where: {
      status: status.SCHEDULED_FOR_PAYMENT,
    },
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.PayoutMethod, as: 'PayoutMethod', where: { type: PayoutMethodTypes.PAYPAL } },
    ],
  });
  const batches = values(groupBy(expenses, 'CollectiveId'));
  logger.info(`Processing ${expenses.length} expense(s) scheduled for payment using PayPal Payouts...`);
  for (const batch of batches) {
    logger.info(`Paying collective ${batch[0]?.CollectiveId} batch with ${batch.length} expense(s)...`);
    await paypal.payExpensesBatch(batch).catch(console.error);
  }
  logger.info('Done!');
}

import { pathToFileURL } from 'url';

if (import.meta.url === pathToFileURL(process.argv[1]).href && process.env.SKIP_PAYPAL_PAYOUTS_WORKER !== 'true') {
  run()
    .then(() => {
      setTimeout(() => process.exit(0), 10000);
    })
    .catch(e => {
      console.error(e);
      reportErrorToSentry(e);
      setTimeout(() => process.exit(0), 10000);
      process.exit(1);
    });
}
