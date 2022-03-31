import activities from '../constants/activities';
import { types as CollectiveTypes } from '../constants/collectives';
import ExpenseStatus from '../constants/expense_status';
import ExpenseType from '../constants/expense_type';
import { TransactionKind } from '../constants/transaction-kind';
import { getFxRate } from '../lib/currency';
import logger from '../lib/logger';
import { toNegative } from '../lib/math';
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

export const persistTransaction = async (virtualCard, transaction) => {
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

  // Case when expense is already created after the stripe authorization request event
  if (transaction.fromAuthorizationId) {
    const processingExpense = await models.Expense.findOne({
      where: {
        VirtualCardId: virtualCard.id,
        data: { authorizationId: transaction.fromAuthorizationId },
      },
    });

    if (processingExpense && processingExpense.status === ExpenseStatus.PROCESSING) {
      await processingExpense.setPaid();
      await processingExpense.update({ data: expenseData });

      await models.Transaction.createDoubleEntry({
        CollectiveId: collective.id,
        FromCollectiveId: vendor.id,
        HostCollectiveId: host.id,
        description,
        type: 'DEBIT',
        currency,
        ExpenseId: processingExpense.id,
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

      return processingExpense;
    }
  }

  const existingExpense = await models.Expense.findOne({
    where: {
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
      data: { refundTransactionId: transactionId },
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
    });

    await models.Transaction.createDoubleEntry({
      CollectiveId: collective.id,
      FromCollectiveId: vendor.id,
      HostCollectiveId: host.id,
      description,
      type: 'DEBIT',
      currency,
      ExpenseId: expense.id,
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

    expense.fromCollective = vendor;
    expense.collective = collective;
    if (collective.settings?.ignoreExpenseMissingReceiptAlerts !== true) {
      expense.createActivity(
        activities.COLLECTIVE_EXPENSE_MISSING_RECEIPT,
        { id: UserId },
        { ...expense.data, user: virtualCard.user },
      );
    }

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

  const [vendor] = await models.Collective.findOrCreate({
    where: { slug },
    defaults: { name: vendorName, type: CollectiveTypes.VENDOR },
  });

  return vendor;
};
