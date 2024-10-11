import assert from 'assert';

import { Request } from 'express';
import { omit, pick, toString } from 'lodash';

import activities from '../../constants/activities';
import { Service } from '../../constants/connected-account';
import expenseStatus from '../../constants/expense-status';
import FEATURE from '../../constants/feature';
import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import logger from '../../lib/logger';
import { createRefundTransaction } from '../../lib/payments';
import { reportErrorToSentry } from '../../lib/sentry';
import { createTransactionsFromPaidExpense } from '../../lib/transactions';
import { getQuote, getTransfer, verifyEvent } from '../../lib/transferwise';
import models from '../../models';
import {
  ExpenseDataQuoteV3,
  QuoteV2PaymentOption,
  QuoteV3PaymentOption,
  TransferRefundEvent,
  TransferStateChangeEvent,
} from '../../types/transferwise';

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

  const connectedAccount = await expense.host.getAccountForPaymentProvider(Service.TRANSFERWISE, {
    throwIfMissing: false,
  });

  let transfer;
  if (!connectedAccount) {
    logger.error(`Wise: No connected account found for host ${expense.host.slug}.`);
    transfer = expense.data.transfer;
  } else {
    transfer = await getTransfer(connectedAccount, event.data.resource.id).catch(e => {
      logger.error(`Wise: Failed to fetch transfer ${event.data.resource.id} from Wise`, e);
      return expense.data.transfer;
    });
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
    // Mark Expense as Paid, create activity and send notifications
    await expense.markAsPaid();
  } else if (expense.status === expenseStatus.PROCESSING && event.data.current_state === 'outgoing_payment_sent') {
    logger.info(`Wise: Transfer sent, marking expense as paid and creating transactions.`, event);
    const feesInHostCurrency = (expense.data.feesInHostCurrency || {}) as {
      paymentProcessorFeeInHostCurrency: number;
      hostFeeInHostCurrency: number;
      platformFeeInHostCurrency: number;
    };

    let paymentOption = expense.data.paymentOption as QuoteV2PaymentOption | QuoteV3PaymentOption;
    // Fetch up-to-date quote to check if payment option has changed
    const quote = await getQuote(connectedAccount, transfer.quoteUuid);
    assert(quote, 'Failed to fetch quote from Wise');
    const wisePaymentOption = quote.paymentOptions.find(p => p.payIn === 'BALANCE' && p.payOut === quote.payOut);
    if (
      // Check if existing quote is QuoteV3
      'price' in paymentOption &&
      // Check if the priceDecisionReferenceId has changed
      paymentOption.price.priceDecisionReferenceId !== wisePaymentOption.price?.priceDecisionReferenceId
    ) {
      logger.warn(`Wise updated the payment option for expense ${expense.id}, updating existing values...`);
      paymentOption = wisePaymentOption;
      const expenseDataQuote = { ...omit(quote, ['paymentOptions']), paymentOption } as ExpenseDataQuoteV3;
      await expense.update({ data: { ...expense.data, quote: expenseDataQuote, paymentOption } });
    }

    if (expense.host?.settings?.transferwise?.ignorePaymentProcessorFees) {
      // TODO: We should not just ignore fees, they should be recorded as a transaction from the host to the collective
      // See https://github.com/opencollective/opencollective/issues/5113
      feesInHostCurrency.paymentProcessorFeeInHostCurrency = 0;
    } else {
      // This is simplified because we enforce sourceCurrency to be the same as hostCurrency
      feesInHostCurrency.paymentProcessorFeeInHostCurrency = Math.round(paymentOption.fee.total * 100);
    }

    const hostAmount =
      expense.feesPayer === 'PAYEE' ? paymentOption.sourceAmount : paymentOption.sourceAmount - paymentOption.fee.total;
    assert(hostAmount, 'Expense is missing paymentOption information');
    const expenseToHostRate = hostAmount ? (hostAmount * 100) / expense.amount : 'auto';

    // This will detect that payoutMethodType=BANK_ACCOUNT and set service=wise AND type=bank_transfer
    await expense.setAndSavePaymentMethodIfMissing();

    await createTransactionsFromPaidExpense(expense.host, expense, feesInHostCurrency, expenseToHostRate, {
      ...pick(expense.data, ['fund']),
      transfer,
      clearedAt: event.data?.occurred_at && new Date(event.data.occurred_at),
    });
    await expense.update({ data: { ...expense.data, feesInHostCurrency, transfer } });

    // Mark Expense as Paid, create activity and send notifications
    await expense.markAsPaid();
  } else if (expense.status === expenseStatus.PROCESSING && event.data.current_state === 'cancelled') {
    logger.info(`Wise: Transfer failed, setting status to error.`, event);
    await expense.update({ data: { ...expense.data, transfer } });
    await expense.setError(expense.lastEditedById);
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_ERROR, null, { isSystem: true, event });
  }
}

const handleTransferRefund = async (event: TransferRefundEvent): Promise<void> => {
  const transferId = event.data.resource.id;
  const refundWiseEventTimestamp = event.data.occurred_at;
  const expense = await models.Expense.findOne({
    where: {
      status: [expenseStatus.PROCESSING, expenseStatus.PAID],
      data: { transfer: { id: transferId } },
    },
    include: [
      {
        model: models.Collective,
        as: 'collective',
        include: [{ model: models.Collective, as: 'host', required: true }],
        required: true,
      },
      { model: models.User, as: 'User' },
      { model: models.Transaction },
    ],
  });

  if (!expense) {
    // This is probably some other transfer not executed through our platform.
    logger.warn('Could not find related Expense, ignoring transferwise event.', event);
    return;
  } else if (expense.data.refundEventTimestamp === refundWiseEventTimestamp) {
    logger.debug('Ignoring duplicate refund event.', event);
    return;
  }

  const collective = expense.collective;
  const host = collective.host;

  const refundCurrency = event.data.resource.refund_currency;
  if (refundCurrency !== expense.data.transfer.sourceCurrency) {
    // This condition is guaranteed by Wise, but we should still check it
    // Can we recover from this? How to infer the correct FX Rate so we know if this is a partial refund or not?
    logger.warn('Refund currency does not match transfer source currency', event);
    throw new Error('Refund currency does not match transfer source currency.');
  }

  const refundedAmount = event.data.resource.refund_amount;
  const sourceAmount = expense.data.transfer.sourceValue;
  const relatedTransferTransactions = expense.Transactions.filter(t => t.data?.transfer?.id === transferId);
  const hasTransactions = relatedTransferTransactions.some(t => t.kind === TransactionKind.EXPENSE);

  if (hasTransactions) {
    assert.equal(refundCurrency, host.currency, 'Refund currency does not match host currency');
    const creditTransaction = relatedTransferTransactions.find(
      t => t.type === TransactionTypes.CREDIT && t.kind === TransactionKind.EXPENSE,
    );
    assert(creditTransaction, 'Could not find related CREDIT transaction');
    const paymentProcessorFee = expense.data.paymentOption.fee.total;

    if (refundedAmount === sourceAmount && expense.status === expenseStatus.PAID) {
      logger.verbose('Wise: Paid Expense was fully refunded', event);
      await createRefundTransaction(
        creditTransaction,
        paymentProcessorFee * 100,
        pick(creditTransaction.data, ['transfer']),
        expense.User,
      );
    } else if (refundedAmount < sourceAmount) {
      logger.verbose('Wise: Paid Expense was partially refunded', event);
      const difference = sourceAmount - refundedAmount;
      const paymentProcessorFee = expense.data.paymentOption.fee.total;
      await createRefundTransaction(
        creditTransaction,
        Math.round((paymentProcessorFee - difference) * 100),
        pick(creditTransaction.data, ['transfer']),
        expense.User,
      );
    }

    await expense.setError(expense.lastEditedById);
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_ERROR, null, { isSystem: true, event });
    await expense.update({ data: { ...expense.data, refundWiseEventTimestamp } });
    await relatedTransferTransactions.map(t => t.update({ data: { ...t.data, refundWiseEventTimestamp } }));
  } else {
    if (refundedAmount === sourceAmount && expense.status === expenseStatus.PROCESSING) {
      logger.verbose('Wise: Expense was never marked as Paid, marking it as error', event);
      await expense.setError(expense.lastEditedById);
      await expense.createActivity(activities.COLLECTIVE_EXPENSE_ERROR, null, { isSystem: true, event });
      await expense.update({ data: { ...expense.data, refundWiseEventTimestamp } });
    } else if (refundedAmount < sourceAmount) {
      logger.verbose(
        'Wise: Expense was never marked as Paid and it was just partially refunded, creating Payment Processor Fee transaction',
        event,
      );
      assert.equal(refundCurrency, host.currency, 'Refund currency does not match host currency');
      const hostCurrency = host.currency;
      const difference = sourceAmount - refundedAmount;
      const paymentProcessorFeeInHostCurrency = difference * 100;
      const hostCurrencyFxRate = await models.Transaction.getFxRate(collective.currency, hostCurrency);
      await models.Transaction.createPaymentProcessorFeeTransactions({
        amount: 0,
        paymentProcessorFeeInHostCurrency,
        currency: collective.currency,
        hostCurrencyFxRate,
        hostCurrency,
        CollectiveId: expense.CollectiveId,
        ExpenseId: expense.id,
        HostCollectiveId: host.id,
        PayoutMethodId: expense.PayoutMethodId,
      });
      await expense.setError(expense.lastEditedById);
      await expense.createActivity(activities.COLLECTIVE_EXPENSE_ERROR, null, { isSystem: true, event });
      await expense.update({ data: { ...expense.data, refundWiseEventTimestamp } });
    }
  }
};

async function webhook(req: Request & { rawBody: string }): Promise<void> {
  const event = verifyEvent(req);

  try {
    switch (event.event_type) {
      case 'transfers#state-change':
        await handleTransferStateChange(event as TransferStateChangeEvent);
        break;
      case 'transfers#refund':
        await handleTransferRefund(event as TransferRefundEvent);
        break;
      default:
        logger.debug('Ignoring unknown Wise event.', event.event_type);
        break;
    }
  } catch (error) {
    logger.error('Error processing Wise event', error);
    reportErrorToSentry(error, { extra: { event }, feature: FEATURE.TRANSFERWISE });
    throw error;
  }
}

export default webhook;
