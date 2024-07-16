import '../../server/env';

import { groupBy, values } from 'lodash';

import status from '../../server/constants/expense-status';
import logger from '../../server/lib/logger';
import models from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import * as paypal from '../../server/paymentProviders/paypal/payouts';
import { runCronJob } from '../utils';

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
  const collectiveBatches = values(groupBy(expenses, 'CollectiveId'));
  logger.info(`Processing ${expenses.length} expense(s) scheduled for payment using PayPal Payouts...`);
  for (const collectiveBatch of collectiveBatches) {
    const currencyBatches = values(groupBy(collectiveBatch, 'currency'));
    // For each currency, we pay all the expenses of the same currency in a single batch due to PayPal limitations
    for (const currencyBatch of currencyBatches) {
      logger.info(
        `Paying collective ${currencyBatch[0].CollectiveId} batch with ${currencyBatch.length} expense(s) in ${currencyBatch[0].currency}...`,
      );
      await paypal.payExpensesBatch(currencyBatch).catch(console.error);
    }
  }
  logger.info('Done!');
}

runCronJob('pay-paypal-scheduled-expenses-payout', run, 60 * 60);
