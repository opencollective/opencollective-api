#!/usr/bin/env node

import '../../server/env';

import { groupBy, values } from 'lodash';

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
  const collectiveBatches = values(groupBy(expenses, 'CollectiveId'), 'currency');
  logger.info(`Processing ${expenses.length} expense(s) scheduled for payment using PayPal Payouts...`);
  for (const collectiveBatch of collectiveBatches) {
    const currencyBatches = values(groupBy(collectiveBatch, 'currency'));
    // For each currency, we pay all the expenses of the same currency in a single batch due to PayPal limitations
    for (const currencyBatch of currencyBatches) {
      logger.info(
        `Paying collective ${currencyBatch[0]?.CollectiveId} batch with ${currencyBatch.length} expense(s) in ${currencyBatch[0].currency}...`,
      );
      await paypal.payExpensesBatch(currencyBatch).catch(console.error);
    }
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
