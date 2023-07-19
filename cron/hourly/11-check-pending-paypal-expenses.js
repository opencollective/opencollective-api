#!/usr/bin/env node

import '../../server/env.js';

import { groupBy, values } from 'lodash-es';
import moment from 'moment';
import { Op } from 'sequelize';

import status from '../../server/constants/expense_status.js';
import logger from '../../server/lib/logger.js';
import { reportErrorToSentry } from '../../server/lib/sentry.js';
import models from '../../server/models/index.js';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod.js';
import { checkBatchStatus } from '../../server/paymentProviders/paypal/payouts.js';

export async function run() {
  const expenses = await models.Expense.findAll({
    where: {
      [Op.or]: [
        { status: status.PROCESSING },
        {
          status: { [Op.notIn]: [status.PAID, status.ERROR, status.REJECTED, status.SPAM] },
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

if (require.main === module) {
  run()
    .then(() => {
      process.exit(0);
    })
    .catch(e => {
      console.error(e);
      reportErrorToSentry(e);
      process.exit(1);
    });
}
