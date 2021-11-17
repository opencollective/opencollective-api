import { omit } from 'lodash';

import activities from '../constants/activities';
import { types as CollectiveTypes } from '../constants/collectives';
import ExpenseStatus from '../constants/expense_status';
import ExpenseType from '../constants/expense_type';
import { TransactionKind } from '../constants/transaction-kind';
import { getFxRate } from '../lib/currency';
import logger from '../lib/logger';
import { toNegative } from '../lib/math';
import models from '../models';

export const getVirtualCardForTransaction = async cardId => {
  const virtualCard = await models.VirtualCard.findOne({
    where: {
      id: cardId,
    },
    include: [
      { association: 'collective', required: true },
      { association: 'host', required: true },
      { association: 'user' },
    ],
  });

  if (!virtualCard) {
    throw new Error('Could not find VirtualCard');
  }

  return virtualCard;
};

export const persistTransaction = async (
  virtualCard,
  amount,
  vendorProviderId,
  vendorName,
  incurredAt,
  transactionToken,
  providerTransaction,
  isRefund = false,
  fromAuthorizationId = null,
) => {
  if (amount === 0) {
    return;
  }

  // Make sure amount is an absolute value
  amount = Math.abs(amount);

  const data = { ...omit(providerTransaction, ['id']), id: transactionToken };
  const UserId = virtualCard.UserId;
  const host = virtualCard.host;
  const collective = virtualCard.collective;
  const vendor = await getOrCreateVendor(vendorProviderId, vendorName);
  const hostCurrencyFxRate = await getFxRate('USD', host.currency);
  const description = `Virtual Card charge: ${vendor.name}`;

  if (fromAuthorizationId) {
    const processingExpense = await models.Expense.findOne({
      where: {
        VirtualCardId: virtualCard.id,
        data: { authorizationId: fromAuthorizationId },
      },
    });

    if (processingExpense && processingExpense.status === ExpenseStatus.PROCESSING) {
      await processingExpense.update({
        status: ExpenseStatus.PAID,
        data,
      });

      await models.Transaction.createDoubleEntry({
        CollectiveId: collective.id,
        FromCollectiveId: vendor.id,
        HostCollectiveId: host.id,
        description,
        type: 'DEBIT',
        currency: 'USD',
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

      return processingExpense;
    }
  }

  const existingExpense = await models.Expense.findOne({
    where: {
      VirtualCardId: virtualCard.id,
      data: { id: transactionToken },
    },
  });

  if (existingExpense) {
    logger.warn(`Virtual Card charge already reconciled, ignoring it: ${transactionToken}`);
    return;
  }

  if (isRefund) {
    const existingTransaction = await models.Transaction.findOne({
      where: {
        CollectiveId: collective.id,
        data: { id: transactionToken },
      },
    });

    if (existingTransaction) {
      logger.warn(`Virtual Card refund already reconciled, ignoring it: ${transactionToken}`);
      return;
    }

    await models.Transaction.createDoubleEntry({
      CollectiveId: collective.id,
      FromCollectiveId: vendor.id,
      HostCollectiveId: host.id,
      description: `Virtual Card refund: ${vendor.name}`,
      type: 'CREDIT',
      currency: 'USD',
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
      data,
    });

    return;
  }

  let expense;

  try {
    expense = await models.Expense.create({
      UserId,
      CollectiveId: collective.id,
      FromCollectiveId: vendor.id,
      currency: 'USD',
      amount,
      description,
      VirtualCardId: virtualCard.id,
      lastEditedById: UserId,
      status: ExpenseStatus.PAID,
      type: ExpenseType.CHARGE,
      incurredAt,
      data: { ...data, missingDetails: true },
    });

    await models.ExpenseItem.create({
      ExpenseId: expense.id,
      incurredAt,
      CreatedByUserId: UserId,
      amount,
    });

    await models.Transaction.createDoubleEntry({
      CollectiveId: collective.id,
      FromCollectiveId: vendor.id,
      HostCollectiveId: host.id,
      description,
      type: 'DEBIT',
      currency: 'USD',
      ExpenseId: expense.id,
      amount,
      netAmountInCollectiveCurrency: amount,
      hostCurrency: host.currency,
      amountInHostCurrency: Math.round(amount * hostCurrencyFxRate),
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
