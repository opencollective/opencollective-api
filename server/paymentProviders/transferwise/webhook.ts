import assert from 'assert';

import { Request } from 'express';
import { pick, toString } from 'lodash-es';

import activities from '../../constants/activities.js';
import expenseStatus from '../../constants/expense_status.js';
import { TransactionKind } from '../../constants/transaction-kind.js';
import logger from '../../lib/logger.js';
import * as libPayments from '../../lib/payments.js';
import { createTransactionsFromPaidExpense } from '../../lib/transactions.js';
import { verifyEvent } from '../../lib/transferwise.js';
import models from '../../models/index.js';
import { QuoteV2PaymentOption, TransferStateChangeEvent } from '../../types/transferwise.js';

export async function handleTransferStateChange(event: TransferStateChangeEvent): Promise<void> {
  const expense = await models.Expense.findOne({
    where: {
      status: [expenseStatus.PROCESSING, expenseStatus.PAID],
      data: { transfer: { id: toString(event.data.resource.id) } },
    },
    include: [
      { model: models.Collective, as: 'host' },
      { model: models.User, as: 'User' },
    ],
  });

  if (!expense) {
    // This is probably some other transfer not executed through our platform.
    logger.debug('Ignoring transferwise event.', event);
    return;
  }

  const transaction = await models.Transaction.findOne({
    where: {
      ExpenseId: expense.id,
      data: { transfer: { id: toString(event.data.resource.id) } },
    },
  });
  if (
    transaction &&
    expense.status === expenseStatus.PROCESSING &&
    event.data.current_state === 'outgoing_payment_sent'
  ) {
    logger.info(`Wise: Transfer sent, marking expense as paid.`, event);
    await expense.setPaid(expense.lastEditedById);
    const user = await models.User.findByPk(expense.lastEditedById);
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_PAID, user);
  } else if (expense.status === expenseStatus.PROCESSING && event.data.current_state === 'outgoing_payment_sent') {
    logger.info(`Wise: Transfer sent, marking expense as paid and creating transactions.`, event);
    const feesInHostCurrency = (expense.data.feesInHostCurrency || {}) as {
      paymentProcessorFeeInHostCurrency: number;
      hostFeeInHostCurrency: number;
      platformFeeInHostCurrency: number;
    };

    const paymentOption = expense.data.paymentOption as QuoteV2PaymentOption;
    if (expense.host?.settings?.transferwise?.ignorePaymentProcessorFees) {
      // TODO: We should not just ignore fees, they should be recorded as a transaction from the host to the collective
      // See https://github.com/opencollective/opencollective/issues/5113
      feesInHostCurrency.paymentProcessorFeeInHostCurrency = 0;
    } else {
      feesInHostCurrency.paymentProcessorFeeInHostCurrency = Math.round(paymentOption.fee.total * 100);
    }

    const hostAmount =
      expense.feesPayer === 'PAYEE' ? paymentOption.sourceAmount : paymentOption.sourceAmount - paymentOption.fee.total;
    assert(hostAmount, 'Expense is missing paymentOption information');
    const expenseToHostRate = hostAmount ? (hostAmount * 100) / expense.amount : 'auto';

    const user = await models.User.findByPk(expense.lastEditedById);
    await createTransactionsFromPaidExpense(
      expense.host,
      expense,
      feesInHostCurrency,
      expenseToHostRate,
      pick(expense.data, ['fund', 'transfer']),
    );

    await expense.update({ data: { ...expense.data, feesInHostCurrency } });
    await expense.setPaid(expense.lastEditedById);
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_PAID, user);
  } else if (
    (expense.status === expenseStatus.PROCESSING || expense.status === expenseStatus.PAID) &&
    (event.data.current_state === 'funds_refunded' || event.data.current_state === 'cancelled')
  ) {
    logger.info(`Wise: Transfer failed, setting status to error and refunding existing transactions.`, event);
    const transaction = await models.Transaction.findOne({
      where: {
        ExpenseId: expense.id,
        RefundTransactionId: null,
        kind: TransactionKind.EXPENSE,
        isRefund: false,
        data: { transfer: { id: toString(event.data.resource.id) } },
      },
      include: [{ model: models.Expense }],
    });
    if (transaction) {
      await libPayments.createRefundTransaction(
        transaction,
        transaction.paymentProcessorFeeInHostCurrency,
        null,
        expense.User,
      );
      logger.info(`Wise: Refunded transactions for Wise transfer #${event.data.resource.id}.`);
    } else {
      logger.info(`Wise: Wise transfer #${event.data.resource.id} has no transactions, skipping refund.`);
    }
    await expense.setError(expense.lastEditedById);
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_ERROR, null, { isSystem: true, event });
  }
}

async function webhook(req: Request & { rawBody: string }): Promise<void> {
  const event = verifyEvent(req);

  switch (event.event_type) {
    case 'transfers#state-change':
      await handleTransferStateChange(event as TransferStateChangeEvent);
      break;
    default:
      break;
  }
}

export default webhook;
