import '../../server/env';

import { groupBy, values } from 'lodash';

import status from '../../server/constants/expense-status';
import logger from '../../server/lib/logger';
import models from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import * as paypal from '../../server/paymentProviders/paypal/payouts';
import { runCronJob } from '../utils';

export async function run(): Promise<void> {
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
    let expensesToPay: typeof collectiveBatch;
    try {
      // Paid without anyone else involved: check again that the payouts are still authorized. All the payouts of the
      // collective are checked together, whatever their currency, so that its balance is shared the same way every run.
      const host = await collectiveBatch[0].collective.getHostCollective();
      expensesToPay = await paypal.checkScheduledPayoutsBeforePaying(host, collectiveBatch);
    } catch (e) {
      logger.error(`Error checking PayPal payouts for collective ${collectiveBatch[0].CollectiveId}`, e);
      continue;
    }

    const currencyBatches = values(groupBy(expensesToPay, 'currency'));
    // For each currency, we pay all the expenses of the same currency in a single batch due to PayPal limitations
    for (const currencyBatch of currencyBatches) {
      logger.info(
        `Paying collective ${currencyBatch[0].CollectiveId} batch with ${currencyBatch.length} expense(s) in ${currencyBatch[0].currency}...`,
      );
      await paypal.payExpensesBatch(currencyBatch).catch(e => {
        logger.error(`Error paying PayPal batch for collective ${currencyBatch[0].CollectiveId}`, e);
      });
    }
  }
  logger.info('Done!');
}

if (require.main === module) {
  runCronJob('pay-paypal-scheduled-expenses-payout', run, 60 * 60);
}
