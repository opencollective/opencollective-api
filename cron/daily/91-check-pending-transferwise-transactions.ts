import '../../server/env';

import moment from 'moment';
import { Op } from 'sequelize';

import status from '../../server/constants/expense-status';
import logger from '../../server/lib/logger';
import { reportErrorToSentry } from '../../server/lib/sentry';
import * as transferwiseLib from '../../server/lib/transferwise';
import models from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import { handleTransferStateChange } from '../../server/paymentProviders/transferwise/webhook';
import { TransferStateChangeEvent } from '../../server/types/transferwise';
import { runCronJob } from '../utils';

async function processExpense(expense) {
  logger.info(`Processing expense #${expense.id}...`);
  const host = expense.host || (await expense.collective.getHostCollective());
  if (!host) {
    throw new Error(`Could not find the host embursing the expense #${expense.id}.`);
  }
  const [connectedAccount] = await host.getConnectedAccounts({
    where: { service: 'transferwise', deletedAt: null },
  });
  if (!connectedAccount) {
    throw new Error(`Host #${host.id} is not connected to Transferwise.`);
  }
  const transfer = await transferwiseLib.getTransfer(connectedAccount, expense.data.transfer.id);
  if (
    (expense.status === status.PROCESSING && transfer.status === 'outgoing_payment_sent') ||
    transfer.status === 'funds_refunded'
  ) {
    logger.info(`Wise: Transfer updated.`, transfer);
    await handleTransferStateChange({
      // eslint-disable-next-line camelcase
      data: { resource: { id: transfer.id, type: 'transfer' }, current_state: transfer.status },
    } as TransferStateChangeEvent);
  }
}
/**
 * Updates the status of expenses being processed through Wise.
 * This process is redundant and it works as a fallback for the Webhook endpoint.
 */
export async function run() {
  const expenses = await models.Expense.findAll({
    where: {
      [Op.or]: [
        // Pending expenses
        { status: status.PROCESSING },
        // Expense might bounce back in the last week
        {
          status: status.PAID,
          updatedAt: {
            [Op.gte]: moment().subtract(7, 'days').toDate(),
          },
        },
      ],
      data: { transfer: { [Op.ne]: null } },
    },
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.Collective, as: 'host' },
      {
        model: models.PayoutMethod,
        as: 'PayoutMethod',
        required: true,
        where: { type: PayoutMethodTypes.BANK_ACCOUNT },
      },
    ],
  });
  logger.info(`There are ${expenses.length} Wise transactions to verify...`);

  for (const expense of expenses) {
    await processExpense(expense).catch(e => {
      console.error(e);
      reportErrorToSentry(e);
    });
  }
}

runCronJob('check-pending-transferwise-transactions', run, 24 * 60 * 60);
