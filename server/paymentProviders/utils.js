import activities from '../constants/activities';
import { types as CollectiveTypes } from '../constants/collectives';
import ExpenseStatus from '../constants/expense_status';
import ExpenseType from '../constants/expense_type';
import { TransactionKind } from '../constants/transaction-kind';
import { getFxRate } from '../lib/currency';
import logger from '../lib/logger';
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
) => {
  if (amount === 0) {
    return;
  }

  const UserId = virtualCard.UserId;
  const host = virtualCard.host;
  const collective = virtualCard.collective;

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

  // If it is refund, we'll check if the transaction was already created because there are no expenses created for refunds.
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
  }

  let expense;

  try {
    const slug = vendorProviderId.toString().toLowerCase();
    const [vendor] = await models.Collective.findOrCreate({
      where: { slug },
      defaults: { name: vendorName, type: CollectiveTypes.VENDOR },
    });

    const hostCurrencyFxRate = await getFxRate('USD', host.currency);

    // If it is a refund, we'll just create the transaction pair
    if (isRefund) {
      await models.Transaction.createDoubleEntry({
        CollectiveId: vendor.id,
        FromCollectiveId: collective.id,
        HostCollectiveId: host.id,
        description: `Virtual Card refund: ${vendor.name}`,
        type: 'DEBIT',
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
        data: providerTransaction,
      });
    } else {
      const description = `Virtual Card charge: ${vendor.name}`;

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
        data: { ...providerTransaction, missingDetails: true },
      });

      await models.ExpenseItem.create({
        ExpenseId: expense.id,
        incurredAt,
        CreatedByUserId: UserId,
        amount,
      });

      await models.Transaction.createDoubleEntry({
        // Note that Collective and FromCollective here are inverted because this is the CREDIT transaction
        CollectiveId: vendor.id,
        FromCollectiveId: collective.id,
        HostCollectiveId: host.id,
        description,
        type: 'CREDIT',
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
