#!/usr/bin/env node

import '../../server/env';

import { flatten, groupBy, values } from 'lodash';

import status from '../../server/constants/expense_status';
import logger from '../../server/lib/logger';
import { reportErrorToSentry } from '../../server/lib/sentry';
import models from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import * as paypal from '../../server/paymentProviders/paypal/payouts';

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
  const batches = flatten(values(groupBy(values(groupBy(expenses, 'CollectiveId'), 'currency'))));
  logger.info(`Processing ${expenses.length} expense(s) scheduled for payment using PayPal Payouts...`);
  for (const batch of batches) {
    logger.info(`Paying collective ${batch[0]?.CollectiveId} batch with ${batch.length} expense(s)...`);
    await paypal.payExpensesBatch(batch).catch(console.error);
  }
  logger.info('Done!');
}

if (require.main === module && process.env.SKIP_PAYPAL_PAYOUTS_WORKER !== 'true') {
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
