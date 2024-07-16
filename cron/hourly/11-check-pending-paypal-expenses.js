import '../../server/env';

import { groupBy, values } from 'lodash';
import moment from 'moment';
import { Op } from 'sequelize';

import status from '../../server/constants/expense-status';
import logger from '../../server/lib/logger';
import { reportErrorToSentry } from '../../server/lib/sentry';
import models from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import { checkBatchStatus } from '../../server/paymentProviders/paypal/payouts';
import { runCronJob } from '../utils';

async function run() {
  const expenses = await models.Expense.findAll({
    where: {
      [Op.or]: [
        { status: status.PROCESSING },
        {
          status: { [Op.notIn]: [status.PAID, status.ERROR, status.REJECTED, status.SPAM, status.INCOMPLETE] },
          updatedAt: {
            // 40 so we can cover the 30 day limit
            [Op.gte]: moment().subtract(40, 'days').toDate(),
          },
        },
      ],
      // 30 minutes window to avoid race conditions with the webhook interface
      updatedAt: { [Op.lte]: moment().subtract(30, 'minutes').toDate() },
      'data.payout_batch_id': { [Op.not]: null },
    },
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.PayoutMethod, as: 'PayoutMethod', where: { type: PayoutMethodTypes.PAYPAL } },
    ],
  });
  const batches = values(groupBy(expenses, 'data.payout_batch_id'));
  logger.info(`Checking the status of ${expenses.length} transaction(s) paid using PayPal Payouts...`);
  for (const batch of batches) {
    logger.info(`Checking host ${batch[0]?.collective?.HostCollectiveId} batch with ${batch.length} expense(s)...`);
    await checkBatchStatus(batch).catch(e => {
      console.error(e);
      reportErrorToSentry(e);
    });
  }
  logger.info('Done!');
}

runCronJob('check-pending-paypal-expenses', run, 60 * 60 * 1000);
