#!/usr/bin/env node

import '../../server/env';

import { groupBy, values } from 'lodash';
import moment from 'moment';
import { Op } from 'sequelize';

import status from '../../server/constants/expense_status';
import models from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import { checkBatchStatus } from '../../server/paymentProviders/paypal/payouts';

export async function run() {
  const expenses = await models.Expense.findAll({
    where: {
      [Op.or]: [
        { status: status.PROCESSING },
        {
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
  for (const batch of batches) {
    await checkBatchStatus(batch).catch(console.error);
  }
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
