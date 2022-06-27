#!/usr/bin/env node
import '../../server/env';

import moment from 'moment';
import { Op } from 'sequelize';

import activities from '../../server/constants/activities';
import status from '../../server/constants/expense_status';
import { reportErrorToSentry } from '../../server/lib/sentry';
import * as transferwiseLib from '../../server/lib/transferwise';
import models from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import transferwise from '../../server/paymentProviders/transferwise';

async function processExpense(expense) {
  console.log(`\nProcessing expense #${expense.id}...`);
  const host = await expense.collective.getHostCollective();
  if (!host) {
    throw new Error(`Could not find the host embursing the expense.`);
  }
  const [connectedAccount] = await host.getConnectedAccounts({
    where: { service: 'transferwise', deletedAt: null },
  });
  if (!connectedAccount) {
    throw new Error(`Host is not connected to Transferwise.`);
  }
  const [transaction] = expense.Transactions;
  if (!transaction) {
    throw new Error(`Could not find any transactions associated with expense.`);
  }
  const token = await transferwise.getToken(connectedAccount);
  const transfer = await transferwiseLib.getTransfer(token, transaction.data.transfer.id);
  if (transfer.status === 'processing') {
    console.warn(`Transfer is still being processed, nothing to do but wait.`);
  } else if (expense.status === status.PROCESSING && transfer.status === 'outgoing_payment_sent') {
    console.log(`Transfer sent, marking expense as paid.`);
    await expense.setPaid(expense.lastEditedById);
    const user = await models.User.findByPk(expense.lastEditedById);
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_PAID, user);
  } else if (transfer.status === 'funds_refunded') {
    console.warn(`Transfer ${transfer.status}, setting status to Error and deleting existing transactions.`);
    await models.Transaction.destroy({ where: { ExpenseId: expense.id } });
    await expense.setError(expense.lastEditedById);
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_ERROR);
  }
}
/**
 * Updates the status of expenses being processed through Transferwise.
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
    },
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.Transaction, where: { data: { transfer: { [Op.ne]: null } } } },
      { model: models.PayoutMethod, as: 'PayoutMethod', where: { type: PayoutMethodTypes.BANK_ACCOUNT } },
    ],
  });
  console.log(`There are ${expenses.length} TransferWise transactions to verify...`);

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
