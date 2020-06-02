/* eslint-disable @typescript-eslint/camelcase, camelcase */

import { isNil, round, toNumber } from 'lodash';
import moment from 'moment';

import activities from '../../constants/activities';
import status from '../../constants/expense_status';
import * as paypal from '../../lib/paypal';
import { createFromPaidExpense as createTransactionFromPaidExpense } from '../../lib/transactions';

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

export const checkBatchStatus = async (batch: any[]): Promise<any[]> => {
  const [firstExpense] = batch;
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

  const batchId = firstExpense.data.payout_batch_id;
  const batchInfo = await paypal.getBatchInfo(connectedAccount, batchId);
  const checkExpense = async (expense: any): Promise<any> => {
    try {
      const item = batchInfo.items.find(i => i.payout_item.sender_item_id === expense.id.toString());
      if (!item) {
        throw new Error('Could not find expense in payouts batch');
      }

      const paymentProcessorFeeInHostCurrency = round(toNumber(item.payout_item_fee?.value) * 100);
      switch (item.transaction_status) {
        case 'SUCCESS':
          await createTransactionFromPaidExpense(
            host,
            null,
            expense,
            null,
            expense.UserId,
            paymentProcessorFeeInHostCurrency,
            0,
            0,
            item,
          );
          await expense.setPaid(expense.lastEditedById);
          await expense.createActivity(activities.COLLECTIVE_EXPENSE_PAID);
          break;
        case 'FAILED':
        case 'BLOCKED':
        case 'REFUNDED':
        case 'RETURNED':
        case 'REVERSED':
          await expense.setError(expense.lastEditedById);
          await expense.createActivity(activities.COLLECTIVE_EXPENSE_ERROR);
          break;
        // Ignore cases
        case 'ONHOLD':
        case 'UNCLAIMED': // Link sent to a non-paypal user, waiting for being claimed.
        case 'PENDING':
        default:
          console.warn(`Expense is still being processed, nothing to do but wait.`);
          break;
      }
      return expense;
    } catch (e) {
      console.error(e);
    }
  };

  for (const expense of batch) {
    await checkExpense(expense);
  }
  return batch;
};
