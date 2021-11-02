/* eslint-disable camelcase */
import { isEmpty, omit, toString } from 'lodash';

import activities from '../../constants/activities';
import { types as CollectiveTypes } from '../../constants/collectives';
import ExpenseStatus from '../../constants/expense_status';
import ExpenseType from '../../constants/expense_type';
import { TransactionKind } from '../../constants/transaction-kind';
import { getFxRate } from '../../lib/currency';
import logger from '../../lib/logger';
import * as privacy from '../../lib/privacy';
import models from '../../models';
import VirtualCardModel from '../../models/VirtualCard';
import { Transaction } from '../../types/privacy';
import { CardProviderService } from '../types';

const processTransaction = async (
  privacyTransaction: Transaction,
  opts?: { host?: any; collective?: any; hostCurrencyFxRate?: number },
): Promise<typeof models.Expense | undefined> => {
  const amount = privacyTransaction.settled_amount;
  // Privacy can set transactions amount to zero in certain cases. We'll ignore those.
  if (!amount) {
    return;
  }

  const virtualCard = await models.VirtualCard.findOne({
    where: {
      id: privacyTransaction.card.token,
    },
    include: [
      { association: 'collective', required: true },
      { association: 'host', required: true },
      { association: 'user' },
    ],
  });
  if (!virtualCard) {
    logger.error(`Couldn't find the related Virtual Card ${privacyTransaction.card.last_four}`);
    return;
  }

  const collective = opts?.collective || virtualCard.collective;
  if (!collective) {
    logger.error(`Couldn't find the related collective`);
  }
  const existingExpense = await models.Expense.findOne({
    where: {
      CollectiveId: collective.id,
      VirtualCardId: virtualCard.id,
      data: { token: privacyTransaction.token },
    },
  });
  if (existingExpense) {
    logger.warn(`Virtual Card charge already reconciled, ignoring it: ${privacyTransaction.token}`);
    return;
  }

  const host = opts?.host || virtualCard.host;
  const hostCurrencyFxRate = opts?.hostCurrencyFxRate || (await getFxRate('USD', host.currency));
  const UserId = virtualCard.UserId || collective.CreatedByUserId || collective.LastEditedByUserId;
  const isRefund = amount < 0;

  // If it is refund, we'll check if the transaction was already created because there are no expenses created for refunds.
  if (isRefund) {
    const existingTransaction = await models.Transaction.findOne({
      where: {
        CollectiveId: collective.id,
        data: { token: privacyTransaction.token },
      },
    });
    if (existingTransaction) {
      logger.warn(`Virtual Card refund already reconciled, ignoring it: ${privacyTransaction.token}`);
      return;
    }
  }

  let expense;
  try {
    const slug = toString(privacyTransaction.merchant.acceptor_id).toLowerCase();
    const [vendor] = await models.Collective.findOrCreate({
      where: { slug },
      defaults: { name: privacyTransaction.merchant.descriptor, type: CollectiveTypes.VENDOR },
    });

    // If it is a refund, we'll just create the transaction pair
    if (isRefund) {
      await models.Transaction.createDoubleEntry({
        CollectiveId: vendor.id,
        FromCollectiveId: collective.id,
        HostCollectiveId: host.id,
        description: `Virtual Card refund: ${vendor.name}`,
        type: 'DEBIT',
        currency: 'USD',
        amount,
        netAmountInCollectiveCurrency: amount,
        hostCurrency: host.currency,
        amountInHostCurrency: Math.round(amount * hostCurrencyFxRate),
        paymentProcessorFeeInHostCurrency: 0,
        hostFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        hostCurrencyFxRate,
        isRefund: true,
        kind: TransactionKind.EXPENSE,
        data: privacyTransaction,
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
        incurredAt: privacyTransaction.created,
        data: { ...privacyTransaction, missingDetails: true },
      });

      await models.ExpenseItem.create({
        ExpenseId: expense.id,
        incurredAt: privacyTransaction.created,
        CreatedByUserId: UserId,
        amount,
      });

      await models.Transaction.createDoubleEntry({
        // Note that Colective and FromCollective here are inverted because this is the CREDIT transaction
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
    logger.error(e);
    if (expense) {
      await models.Transaction.destroy({ where: { ExpenseId: expense.id } });
      await models.ExpenseItem.destroy({ where: { ExpenseId: expense.id } });
      await expense.destroy().catch(logger.error);
    }
    throw e;
  }
};

const assignCardToCollective = async (
  cardNumber: string,
  expireDate: string,
  cvv: string,
  collectiveId: number,
  host: any,
  userId: number,
): Promise<VirtualCardModel> => {
  const [connectedAccount] = await host.getConnectedAccounts({ where: { service: 'privacy' } });

  if (!connectedAccount) {
    throw new Error('Host is not connected to Privacy');
  }

  const last_four = cardNumber.slice(-4);
  const card = await privacy.findCard(connectedAccount.token, { last_four });

  if (!card || (card.pan && card.pan !== cardNumber)) {
    throw new Error('Could not find a Privacy Card matching the submitted card');
  }

  const cardData = {
    id: card.token,
    name: card.memo || card.last_four,
    last4: card.last_four,
    privateData: { cardNumber, expireDate, cvv },
    data: omit(card, ['pan', 'cvv', 'exp_year', 'exp_month']),
    CollectiveId: collectiveId,
    HostCollectiveId: host.id,
    UserId: userId,
    provider: 'PRIVACY',
    spendingLimitAmount: card['spend_limit'] === 0 ? null : card['spend_limit'],
    spendingLimitInterval: card['spend_limit_duration'],
  };

  return await models.VirtualCard.create(cardData);
};

const refreshCardDetails = async (virtualCard: VirtualCardModel) => {
  const connectedAccount = await models.ConnectedAccount.findOne({
    where: { service: 'privacy', deletedAt: null, CollectiveId: virtualCard.HostCollectiveId },
  });

  if (!connectedAccount) {
    throw new Error('Host is not connected to Privacy');
  }

  const [card] = await privacy.listCards(connectedAccount.token, virtualCard.id);
  if (!card) {
    throw new Error(`Could not find card ${virtualCard.id}`);
  }
  if (card.state === 'CLOSED') {
    await virtualCard.destroy();
  } else {
    const newData = omit(card, ['pan', 'cvv', 'exp_year', 'exp_month']);
    await virtualCard.update({ data: newData });
  }
  return virtualCard;
};

const setCardState = async (virtualCard: VirtualCardModel, state: 'OPEN' | 'PAUSED'): Promise<VirtualCardModel> => {
  const host = await models.Collective.findByPk(virtualCard.HostCollectiveId);
  const [connectedAccount] = await host.getConnectedAccounts({ where: { service: 'privacy' } });

  if (!connectedAccount) {
    throw new Error('Host is not connected to Privacy');
  }

  // eslint-disable-next-line camelcase
  const card = await privacy.updateCard(connectedAccount.token, { card_token: virtualCard.id, state });

  return virtualCard.update({
    data: omit(card, ['pan', 'cvv', 'exp_year', 'exp_month']),
  });
};

const pauseCard = async (virtualCard: VirtualCardModel): Promise<VirtualCardModel> =>
  setCardState(virtualCard, 'PAUSED');

const resumeCard = async (virtualCard: VirtualCardModel): Promise<VirtualCardModel> =>
  setCardState(virtualCard, 'OPEN');

const deleteCard = async (virtualCard: VirtualCardModel): Promise<void> => {
  const host = await models.Collective.findByPk(virtualCard.HostCollectiveId);
  const [connectedAccount] = await host.getConnectedAccounts({ where: { service: 'privacy' } });

  if (!connectedAccount) {
    throw new Error('Host is not connected to Privacy');
  }

  const [card] = await privacy.listCards(connectedAccount.token, virtualCard.id);
  if (!card) {
    throw new Error(`Could not find card ${virtualCard.id}`);
  }

  if (card.state !== 'CLOSED') {
    // eslint-disable-next-line camelcase
    await privacy.updateCard(connectedAccount.token, { card_token: virtualCard.id, state: 'CLOSED' });
  }

  return virtualCard.destroy();
};

const autoPauseResumeCard = async (virtualCard: VirtualCardModel) => {
  const pendingExpenses = await virtualCard.getExpensesMissingDetails();
  const hasPendingExpenses = !isEmpty(pendingExpenses);

  if (hasPendingExpenses && virtualCard.data.state === 'OPEN') {
    await pauseCard(virtualCard);
  } else if (!hasPendingExpenses && virtualCard.data.state === 'PAUSED') {
    await resumeCard(virtualCard);
  }
};

const PrivacyCardProviderService = {
  processTransaction,
  assignCardToCollective,
  autoPauseResumeCard,
  pauseCard,
  resumeCard,
  deleteCard,
  refreshCardDetails,
} as CardProviderService;

export default PrivacyCardProviderService;
