#!/usr/bin/env node
import '../../server/env.js';
import '../../server/lib/sentry.js';

import moment from 'moment';
import { Op } from 'sequelize';

import status from '../../server/constants/expense_status.js';
import logger from '../../server/lib/logger.js';
import { reportErrorToSentry } from '../../server/lib/sentry.js';
import * as transferwiseLib from '../../server/lib/transferwise.js';
import models from '../../server/models/index.js';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod.js';
import { handleTransferStateChange } from '../../server/paymentProviders/transferwise/webhook.js';
import { TransferStateChangeEvent } from '../../server/types/transferwise.js';

async function processExpense(expense) {
  logger.info(`Processing expense #${expense.id}...`);
  const host = await expense.collective.getHostCollective();
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
