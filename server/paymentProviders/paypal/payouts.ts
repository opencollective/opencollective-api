/* eslint-disable camelcase */
import { isNil, round, toNumber } from 'lodash';
import { v4 as uuid } from 'uuid';

import activities from '../../constants/activities';
import { Service } from '../../constants/connected-account';
import status from '../../constants/expense-status';
import FEATURE from '../../constants/feature';
import { getFxRate } from '../../lib/currency';
import logger from '../../lib/logger';
import { floatAmountToCents } from '../../lib/math';
import * as paypal from '../../lib/paypal';
import { safeJsonStringify } from '../../lib/safe-json-stringify';
import { reportErrorToSentry, reportMessageToSentry } from '../../lib/sentry';
import { createTransactionsFromPaidExpense } from '../../lib/transactions';
import models, { Collective } from '../../models';
import Expense from '../../models/Expense';
import { PayoutItemDetails } from '../../types/paypal';

const PROVIDER_NAME = Service.PAYPAL;

export const payExpensesBatch = async (expenses: Expense[]): Promise<Expense[]> => {
  const [firstExpense] = expenses;
  const isSameHost = expenses.every(
    e =>
      !isNil(e.collective?.HostCollectiveId) &&
      e.collective.HostCollectiveId === firstExpense.collective.HostCollectiveId,
  );
  if (!isSameHost) {
    throw new Error('All expenses should have collective prop populated and belong to the same Host.');
  }

  const host = await firstExpense.collective.getHostCollective();
  if (!host) {
    throw new Error(`Could not find the host reimbursing the expense.`);
  }

  const connectedAccount = await host.getAccountForPaymentProvider(PROVIDER_NAME);

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const getExpenseItem = expense => ({
    note: `Expense #${expense.id}: ${expense.description}`,
    amount: {
      currency: expense.currency,
      value: round(expense.amount / 100, 2).toString(),
    },
    receiver: expense.PayoutMethod.data.email,
    sender_item_id: expense.id,
  });

  // Map expense items...
  const items = expenses.map(getExpenseItem);
  const sender_batch_id = uuid();

  const requestBody = {
    sender_batch_header: {
      recipient_type: 'EMAIL',
      email_message: 'Good news, your expense was paid!',
      email_subject: `Expense Payout for ${firstExpense.collective.name}`,
      sender_batch_id,
    },
    items,
  };

  try {
    const response = await paypal.executePayouts(connectedAccount, requestBody);
    const updateExpenses = expenses.map(async e => {
      await e.update({ data: { ...e.data, ...response.batch_header }, status: status.PROCESSING });
      const user = await models.User.findByPk(e.lastEditedById);
      await e.createActivity(activities.COLLECTIVE_EXPENSE_PROCESSING, user);
      return e;
    });
    return Promise.all(updateExpenses);
  } catch (error) {
    reportErrorToSentry(error, { feature: FEATURE.PAYPAL_PAYOUTS });
    const updateExpenses = expenses.map(async e => {
      await e.update({ status: status.ERROR, data: { ...e.data, error } });
      const user = await models.User.findByPk(e.lastEditedById);
      await e.createActivity(activities.COLLECTIVE_EXPENSE_ERROR, user, {
        error: { message: error.message, details: safeJsonStringify(error) },
        isSystem: true,
      });
      return e;
    });
    return Promise.all(updateExpenses);
  }
};

export const checkBatchItemStatus = async (
  item: PayoutItemDetails,
  expense: Expense,
  host: Collective,
): Promise<Expense> => {
  // Reload up-to-date values to avoid race conditions when processing batches.
  await expense.reload();
  if (expense.data.payout_batch_id !== item.payout_batch_id) {
    throw new Error(`Item does not belongs to expense it claims it does.`);
  }

  switch (item.transaction_status) {
    case 'SUCCESS':
      if (expense.status !== status.PAID) {
        const fees = {};
        let fxRate = 1 / (toNumber(item.currency_conversion?.exchange_rate) || 1);

        // When dealing with multi-currency expenses, if the host has a positive balance in the
        // requested expense currency, PayPal will use that and there will be no currency conversion.
        // But because we record the transactions in the host/collective currency, we need still need to
        // get an FX rate from somewhere. We therefore use our internal system to estimate one.
        const payoutItemCurrency = item['payout_item']?.['amount']?.['currency'];
        const isMultiCurrency = payoutItemCurrency && payoutItemCurrency !== expense.currency;
        if (isMultiCurrency && !item.currency_conversion?.exchange_rate) {
          try {
            fxRate = await getFxRate(expense.currency, host.currency);
          } catch (e) {
            // We don't want to fail recording the transaction if we can't get an FX rate, but we'll probably
            // want to go back and update it later.
            logger.error(`Could not fetch FX rate when recording expense #${expense.id} payment`);
          }
        }

        if (item.payout_item_fee) {
          const paymentProcessorFeeInExpenseCurrency = floatAmountToCents(toNumber(item.payout_item_fee.value));
          fees['paymentProcessorFeeInHostCurrency'] = Math.round(paymentProcessorFeeInExpenseCurrency * fxRate);
          if (item.payout_item_fee.currency !== expense.currency) {
            // payout_item_fee is always supposed to be in currency_conversion.to_amount.currency. This is a sanity check just in case
            logger.error(`Payout item fee currency does not match expense #${expense.id} currency`);
            reportMessageToSentry('Payout item fee currency does not match expense currency', {
              extra: { expense: expense.info, item },
            });
          }
        }
        // This will detect that payoutMethodType=PAYPAL and set service=paypal AND type=payout
        await expense.setAndSavePaymentMethodIfMissing();
        await createTransactionsFromPaidExpense(host, expense, fees, fxRate, {
          ...item,
          clearedAt: item.time_processed && new Date(item.time_processed),
        });
        // Mark Expense as Paid, create activity and send notifications
        await expense.markAsPaid();
      }
      break;
    case 'FAILED':
    case 'BLOCKED':
    case 'REFUNDED':
    case 'RETURNED':
    case 'REVERSED':
      if (expense.status !== status.ERROR) {
        await expense.setError(expense.lastEditedById);
        await expense.createActivity(
          activities.COLLECTIVE_EXPENSE_ERROR,
          { id: expense.lastEditedById },
          { error: item.errors, isSystem: true },
        );
      }
      break;
    // Ignore cases
    case 'ONHOLD':
    case 'UNCLAIMED': // Link sent to a non-paypal user, waiting for being claimed.
    case 'PENDING':
    default:
      logger.debug(`Expense is still being processed, nothing to do but wait.`);
      break;
  }
  await expense.update({ data: item });
  return expense;
};

export const checkBatchStatus = async (batch: Expense[]): Promise<Expense[]> => {
  const [firstExpense] = batch;
  const host = await firstExpense.collective.getHostCollective();
  if (!host) {
    throw new Error(`Could not find the host reimbursing the expense.`);
  }

  const connectedAccount = await host.getAccountForPaymentProvider(PROVIDER_NAME);

  const batchId = firstExpense.data.payout_batch_id as string;
  try {
    const batchInfo = await paypal.getBatchInfo(connectedAccount, batchId);
    const checkExpense = async (expense: Expense): Promise<void> => {
      try {
        const item = batchInfo.items.find(i => i.payout_item.sender_item_id === expense.id.toString());
        if (!item) {
          throw new Error('Could not find expense in payouts batch');
        }
        await checkBatchItemStatus(item, expense, host);
      } catch (e) {
        console.error(e);
      }
    };

    for (const expense of batch) {
      await checkExpense(expense);
    }
  } catch (error) {
    reportErrorToSentry(error, { feature: FEATURE.PAYPAL_PAYOUTS });
    throw new Error('There was an error fetching the batch info.');
  }
  return batch;
};
