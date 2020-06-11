#!/usr/bin/env node

import '../../server/env';

import { groupBy, values } from 'lodash';
import moment from 'moment';
import { Op } from 'sequelize';

import status from '../../server/constants/expense_status';
import logger from '../../server/lib/logger';
import models from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import { checkBatchStatus } from '../../server/paymentProviders/paypal/payouts';

export async function run() {
  const expenses = await models.Expense.findAll({
    where: {
      [Op.or]: [
        { status: status.PROCESSING },
        {
          status: { [Op.notIn]: [status.PAID, status.ERROR] },
          updatedAt: {
            [Op.gte]: moment().subtract(15, 'days').toDate(),
          },
        },
      ],
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
    await checkBatchStatus(batch).catch(console.error);
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
      process.exit(1);
    });
}
