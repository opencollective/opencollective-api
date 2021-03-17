import { types as CollectiveTypes } from '../../constants/collectives';
import ExpenseStatus from '../../constants/expense_status';
import ExpenseType from '../../constants/expense_type';
import { getFxRate } from '../../lib/currency';
import logger from '../../lib/logger';
import models, { sequelize } from '../../models';
import { PayoutMethodTypes } from '../../models/PayoutMethod';
import { Transaction } from '../../types/privacy';

const createExpense = async (
  privacyTransaction: Transaction,
  opts?: { host?: any; collective?: any; hostCurrencyFxRate?: number },
): Promise<any> => {
  const payoutMethod = await models.PayoutMethod.findOne({
    where: {
      name: privacyTransaction.card.last_four,
      type: PayoutMethodTypes.CREDIT_CARD,
      data: { token: privacyTransaction.card.token },
    },
  });
  if (!payoutMethod) {
    logger.error(`Couldn't find the related credit card ${privacyTransaction.card.last_four}`);
    return;
  }

  const collective = opts?.collective || (await models.Collective.findByPk(payoutMethod.CollectiveId));
  const existingExpense = await models.Expense.findOne({
    where: {
      FromCollectiveId: collective.id,
      PayoutMethodId: payoutMethod.id,
      data: { token: privacyTransaction.token },
    },
  });
  if (existingExpense) {
    logger.warn('Privacy Credit Card charge already reconciled, ignoring it.');
    return;
  }

  const host = opts?.host || (await collective.getHostCollective());
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
        PayoutMethodId: payoutMethod.id,
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
        HostCollectiveId: collective.HostCollectiveId,
        PayoutMethodId: payoutMethod.id,
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
