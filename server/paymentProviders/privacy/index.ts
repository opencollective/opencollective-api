import { types as CollectiveTypes } from '../../constants/collectives';
import ExpenseStatus from '../../constants/expense_status';
import ExpenseType from '../../constants/expense_type';
import { getFxRate } from '../../lib/currency';
import logger from '../../lib/logger';
import models, { sequelize } from '../../models';
import { Transaction } from '../../types/privacy';

const createExpense = async (
  privacyTransaction: Transaction,
  opts?: { host?: any; collective?: any; hostCurrencyFxRate?: number },
): Promise<any> => {
  const virtualCard = await models.VirtualCard.findOne({
    where: {
      id: privacyTransaction.card.token,
    },
  });
  if (!virtualCard) {
    logger.error(`Couldn't find the related credit card ${privacyTransaction.card.last_four}`);
    return;
  }

  const collective = opts?.collective || (await models.Collective.findByPk(virtualCard.CollectiveId));
  const existingExpense = await models.Expense.findOne({
    where: {
      FromCollectiveId: collective.id,
      VirtualCardId: virtualCard.id,
      data: { token: privacyTransaction.token },
    },
  });
  if (existingExpense) {
    logger.warn('Privacy Credit Card charge already reconciled, ignoring it.');
    return;
  }

  const host = opts?.host || (await models.Collective.findByPk(virtualCard.HostCollectiveId));
  const hostCurrencyFxRate = opts?.hostCurrencyFxRate || (await getFxRate('USD', host.currency));
  const amount = privacyTransaction.settled_amount;

  return await sequelize.transaction(async transaction => {
    const [vendor] = await models.Collective.findOrCreate({
      where: { slug: privacyTransaction.merchant.acceptor_id },
      defaults: { name: privacyTransaction.merchant.descriptor, type: CollectiveTypes.VENDOR },
      transaction,
    });

    const UserId = collective.CreatedByUserId;

    const expense = await models.Expense.create(
      {
        UserId,
        FromCollectiveId: collective.id,
        CollectiveId: vendor.id,
        currency: 'USD',
        amount,
        description: 'Credit Card transaction',
        VirtualCardId: virtualCard.id,
        lastEditedById: UserId,
        status: ExpenseStatus.PAID,
        type: ExpenseType.CHARGE,
        incurredAt: privacyTransaction.created,
        data: privacyTransaction,
      },
      { transaction },
    );

    await models.ExpenseItem.create(
      {
        ExpenseId: expense.id,
        incurredAt: privacyTransaction.created,
        CreatedByUserId: UserId,
        amount,
      },
      { transaction },
    );

    await models.Transaction.createDoubleEntry(
      {
        CollectiveId: vendor.id,
        FromCollectiveId: collective.id,
        HostCollectiveId: host.id,
        description: 'Credit Card transaction',
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
      },
      { transaction },
    );

    expense.collective = vendor;
    return expense;
  });
};

export default {
  createExpense,
};
