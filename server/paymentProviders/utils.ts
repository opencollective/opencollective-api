import slugify from 'limax';

import activities from '../constants/activities';
import { CollectiveType } from '../constants/collectives';
import ExpenseStatus from '../constants/expense-status';
import ExpenseType from '../constants/expense-type';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../constants/paymentMethods';
import { TransactionKind } from '../constants/transaction-kind';
import { TransactionTypes } from '../constants/transactions';
import { getFxRate } from '../lib/currency';
import { crypto } from '../lib/encryption';
import logger from '../lib/logger';
import { toNegative } from '../lib/math';
import { createRefundTransaction } from '../lib/payments';
import models, { Op } from '../models';

export const getVirtualCardForTransaction = async cardId => {
  return models.VirtualCard.findOne({
    where: {
      id: cardId,
    },
    include: [
      { association: 'collective', required: true },
      { association: 'host', required: true },
      { association: 'user' },
    ],
  });
};

export const notifyCollectiveMissingReceipt = async (expense, virtualCard) => {
  expense.collective = expense.collective || (await expense.getCollective());
  expense.fromCollective = expense.fromCollective || (await expense.getFromCollective());
  virtualCard = virtualCard || expense.virtualCard || (await expense.getVirtualCard());

  if (expense.collective.settings?.ignoreExpenseMissingReceiptAlerts === true) {
    return;
  }

  expense.createActivity(
    activities.COLLECTIVE_EXPENSE_MISSING_RECEIPT,
    { id: virtualCard.UserId },
    { ...expense.data, user: virtualCard.user },
  );
};

export const persistVirtualCardTransaction = async (virtualCard, transaction) => {
  // Make sure amount is an absolute value
  const amount = Math.abs(transaction.amount);

  if (amount === 0) {
    return;
  }

  const transactionId = transaction.id;
  const expenseData = { transactionId };
  const UserId = virtualCard.UserId;
  const host = virtualCard.host;
  const collective = virtualCard.collective;
  const vendor = await getOrCreateVendor(transaction.vendorProviderId, transaction.vendorName);
  const currency = transaction.currency || 'USD';
  const hostCurrencyFxRate = await getFxRate(currency, host.currency);
  const description = `Virtual Card charge: ${vendor.name}`;
  const paymentMethod = await host.findOrCreatePaymentMethod(
    PAYMENT_METHOD_SERVICE.STRIPE,
    PAYMENT_METHOD_TYPE.VIRTUAL_CARD,
  );

  // Case when expense is already created after the stripe authorization request event
  // Double check if transaction is a refund because sometimes the refund event is sent before the charge event
  if (transaction.fromAuthorizationId && !transaction.isRefund) {
    const processingExpense = await models.Expense.findOne({
      where: {
        status: ExpenseStatus.PROCESSING,
        VirtualCardId: virtualCard.id,
        data: { authorizationId: transaction.fromAuthorizationId },
      },
    });

    if (processingExpense) {
      // Make sure we update the Expense and ExpenseItem amounts.
      // Sometimes there's a difference between the authorized amount and the charged amount.
      await models.ExpenseItem.update({ amount }, { where: { ExpenseId: processingExpense.id } });
      await processingExpense.update({
        amount,
        PaymentMethodId: paymentMethod.id,
        data: { ...expenseData, missingDetails: true, ...transaction.data },
      });
      // Mark Expense as Paid, create activity and don't send notifications
      await processingExpense.markAsPaid({ skipActivity: true });

      await models.Transaction.createDoubleEntry({
        CollectiveId: collective.id,
        FromCollectiveId: vendor.id,
        HostCollectiveId: host.id,
        description,
        type: 'DEBIT',
        currency,
        ExpenseId: processingExpense.id,
        PaymentMethodId: paymentMethod.id,
        amount: toNegative(amount),
        netAmountInCollectiveCurrency: toNegative(amount),
        hostCurrency: host.currency,
        amountInHostCurrency: Math.round(toNegative(amount) * hostCurrencyFxRate),
        paymentProcessorFeeInHostCurrency: 0,
        hostFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        hostCurrencyFxRate,
        kind: TransactionKind.EXPENSE,
        data: transaction.data,
        clearedAt: transaction.clearedAt,
      });

      const expenseAttachment = await models.ExpenseAttachedFile.findOne({
        where: { ExpenseId: processingExpense.id },
      });

      const expenseItemWithAttachment = await models.ExpenseItem.findOne({
        where: { ExpenseId: processingExpense.id, url: { [Op.ne]: null } },
      });

      if (!expenseAttachment && !expenseItemWithAttachment) {
        await notifyCollectiveMissingReceipt(processingExpense, virtualCard);
      }

      return processingExpense;
    }
  }

  const existingExpense = await models.Expense.findOne({
    where: {
      status: ExpenseStatus.PAID,
      VirtualCardId: virtualCard.id,
      // TODO : only let transactionId in a few months (today : 11/2021) or make a migration to update data on existing expenses and transactions
      data: { [Op.or]: [{ transactionId }, { id: transactionId }, { token: transactionId }] },
    },
  });

  if (existingExpense) {
    logger.warn(`Virtual Card charge already reconciled, ignoring it: ${transactionId}`);
    return;
  }

  if (transaction.isRefund) {
    const existingTransaction = await models.Transaction.findOne({
      where: {
        CollectiveId: collective.id,
        // TODO : only let refundTransactionId in a few months (today : 11/2021) or make a migration to update data on existing expenses and transactions
        data: {
          [Op.or]: [{ refundTransactionId: transactionId }, { id: transactionId }, { token: transactionId }],
        },
      },
    });

    if (existingTransaction) {
      logger.warn(`Virtual Card refund already reconciled, ignoring it: ${transactionId}`);
      return;
    }

    const expense = await models.Expense.findOne({
      where: {
        CollectiveId: collective.id,
        FromCollectiveId: vendor.id,
        VirtualCardId: virtualCard.id,
        type: ExpenseType.CHARGE,
        status: ExpenseStatus.PAID,
        amount,
      },
      order: [['createdAt', 'DESC']],
    });

    if (expense) {
      const [originalCreditTransaction] = await expense.getTransactions({
        where: { type: TransactionTypes.CREDIT, kind: TransactionKind.EXPENSE },
      });
      if (originalCreditTransaction?.amount === amount) {
        if (!originalCreditTransaction.RefundTransactionId) {
          await createRefundTransaction(
            originalCreditTransaction,
            0,
            { refundTransactionId: transactionId, transaction },
            null,
          );
        }
        return;
      }
    }

    await models.Transaction.createDoubleEntry({
      CollectiveId: collective.id,
      FromCollectiveId: vendor.id,
      HostCollectiveId: host.id,
      description: `Virtual Card refund: ${vendor.name}`,
      type: 'CREDIT',
      currency,
      amount: amount,
      netAmountInCollectiveCurrency: amount,
      hostCurrency: host.currency,
      amountInHostCurrency: Math.round(amount * hostCurrencyFxRate),
      paymentProcessorFeeInHostCurrency: 0,
      hostFeeInHostCurrency: 0,
      platformFeeInHostCurrency: 0,
      hostCurrencyFxRate,
      isRefund: true,
      kind: TransactionKind.EXPENSE,
      ExpenseId: expense?.id,
      PaymentMethodId: paymentMethod.id,
      data: { refundTransactionId: transactionId, transaction },
    });

    return;
  }

  let expense;

  try {
    expense = await models.Expense.create({
      UserId,
      CollectiveId: collective.id,
      FromCollectiveId: vendor.id,
      HostCollectiveId: host.id,
      currency,
      amount,
      description,
      VirtualCardId: virtualCard.id,
      PaymentMethodId: paymentMethod.id,
      lastEditedById: UserId,
      status: ExpenseStatus.PAID,
      type: ExpenseType.CHARGE,
      incurredAt: transaction.incurredAt,
      data: { ...expenseData, missingDetails: true },
    });

    await models.ExpenseItem.create({
      ExpenseId: expense.id,
      incurredAt: transaction.incurredAt,
      CreatedByUserId: UserId,
      amount,
      currency,
    });

    await models.Transaction.createDoubleEntry({
      CollectiveId: collective.id,
      FromCollectiveId: vendor.id,
      HostCollectiveId: host.id,
      description,
      type: 'DEBIT',
      currency,
      ExpenseId: expense.id,
      PaymentMethodId: paymentMethod.id,
      amount: toNegative(amount),
      netAmountInCollectiveCurrency: toNegative(amount),
      hostCurrency: host.currency,
      amountInHostCurrency: Math.round(toNegative(amount) * hostCurrencyFxRate),
      paymentProcessorFeeInHostCurrency: 0,
      hostFeeInHostCurrency: 0,
      platformFeeInHostCurrency: 0,
      hostCurrencyFxRate,
      kind: TransactionKind.EXPENSE,
    });

    await notifyCollectiveMissingReceipt(expense, virtualCard);

    return expense;
  } catch (e) {
    if (expense) {
      await models.Transaction.destroy({ where: { ExpenseId: expense.id } });
      await models.ExpenseItem.destroy({ where: { ExpenseId: expense.id } });
      await expense.destroy();
    }
    throw e;
  }
};

export const getOrCreateVendor = async (vendorProviderId, vendorName) => {
  const slug = vendorProviderId.toString().toLowerCase();
  const hash = crypto.hash(`${slug}${vendorName}`);
  const uniqueSlug = slugify(`${vendorName}-${hash.slice(0, 6)}`);

  const [vendor] = await models.Collective.findOrCreate({
    where: { [Op.or]: [{ slug }, { slug: uniqueSlug }] },
    defaults: { name: vendorName, type: CollectiveType.VENDOR, slug: uniqueSlug },
  });

  if (vendor.name !== vendorName) {
    logger.warn(`Virtual Card: vendor name mismatch for ${vendorProviderId}: '${vendorName}' / '${vendor.name}'`);
  }
  // Update existing vendor to use uniqueSlug.
  if (vendor.slug === slug) {
    await vendor.update({ slug: uniqueSlug });
  }

  return vendor;
};
