/* eslint-disable @typescript-eslint/camelcase, camelcase */

import { isNil, round, toNumber } from 'lodash';
import moment from 'moment';

import activities from '../../constants/activities';
import status from '../../constants/expense_status';
import * as paypal from '../../lib/paypal';

export const payExpensesBatch = async (expenses: any[]): Promise<any[]> => {
  const [firstExpense] = expenses;
  const isSameHost = expenses.every(e => !isNil(e.CollectiveId) && e.CollectiveId === firstExpense.CollectiveId);
  if (!isSameHost) {
    throw new Error('All expenses in the batch should belong to the same Collective.');
  }

  const host = await firstExpense.collective.getHostCollective();
  if (!host) {
    throw new Error(`Could not find the host embursing the expense.`);
  }

  const [connectedAccount] = await host.getConnectedAccounts({
    where: { service: 'paypal', deletedAt: null },
  });
  if (!connectedAccount) {
    throw new Error(`Host is not connected to PayPal Payouts.`);
  }

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const getExpenseItem = expense => ({
    note: `Expense #${expense.id}: ${expense.description}`,
    amount: {
      currency: expense.currency,
      value: round(expense.amount / 100, 2),
    },
    receiver: expense.PayoutMethod.data.email,
    sender_item_id: expense.id,
  });

  const requestBody = {
    sender_batch_header: {
      recipient_type: 'EMAIL',
      email_message: 'Good news, your expense was paid!',
      sender_batch_id: `${firstExpense.collective.slug}-${moment().format('DDMMYYYY-HHmm')}`,
      email_subject: `Expense Payout for ${firstExpense.collective.name}`,
    },
    items: expenses.map(getExpenseItem),
  };

  const response = await paypal.executePayouts(connectedAccount, requestBody);
  const updateExpenses = expenses.map(async e => {
    await e.update({ data: response.batch_header, status: status.PROCESSING });
    await e.createActivity(activities.COLLECTIVE_EXPENSE_PROCESSING);
  });
  return Promise.all(updateExpenses);
};
