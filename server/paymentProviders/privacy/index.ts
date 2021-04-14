/* eslint-disable camelcase */
import { omit } from 'lodash';

import { types as CollectiveTypes } from '../../constants/collectives';
import ExpenseStatus from '../../constants/expense_status';
import ExpenseType from '../../constants/expense_type';
import { getFxRate } from '../../lib/currency';
import logger from '../../lib/logger';
import * as privacy from '../../lib/privacy';
import models, { sequelize } from '../../models';
import VirtualCardModel from '../../models/VirtualCard';
import { Transaction } from '../../types/privacy';
import { CardProviderService } from '../types';

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

const assignCardToCollective = async (
  cardDetails: {
    cardNumber: string;
    expireDate: string;
    cvv: string;
  },
  collective: any,
  host: any,
): Promise<VirtualCardModel> => {
  const [connectedAccount] = await host.getConnectedAccounts({
    where: { service: 'privacy', deletedAt: null },
  });

  if (!connectedAccount) {
    throw new Error('Host is not connected to Privacy');
  }

  const { cardNumber, expireDate, cvv } = cardDetails;
  const last_four = cardNumber.split('  ')[3];
  const card = await privacy.findCard(connectedAccount.token, { last_four });
  if (!card || !(card.pan && card.pan === cardNumber.replace(/\s\s/gm, ''))) {
    throw new Error('Could not find a Privacy credit card matching the submitted card');
  }

  const virtualCard = await models.VirtualCard.create({
    id: card.token,
    name: card.memo || card.last_four,
    last4: card.last_four,
    privateData: { cardNumber, expireDate, cvv },
    data: omit(card, ['pan', 'cvv', 'exp_year', 'exp_month']),
    CollectiveId: collective.id,
    HostCollectiveId: host.id,
  });
  return virtualCard;
};

const setCardState = async (virtualCard: VirtualCardModel, state: 'OPEN' | 'PAUSED'): Promise<VirtualCardModel> => {
  const host = await models.Collective.findByPk(virtualCard.HostCollectiveId);
  const [connectedAccount] = await host.getConnectedAccounts({
    where: { service: 'privacy', deletedAt: null },
  });

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
  const [connectedAccount] = await host.getConnectedAccounts({
    where: { service: 'privacy', deletedAt: null },
  });

  if (!connectedAccount) {
    throw new Error('Host is not connected to Privacy');
  }

  // eslint-disable-next-line camelcase
  await privacy.updateCard(connectedAccount.token, { card_token: virtualCard.id, state: 'CLOSED' });

  return virtualCard.destroy();
};

const PrivacyCardProviderService = {
  createExpense,
  assignCardToCollective,
  pauseCard,
  resumeCard,
  deleteCard,
} as CardProviderService;

export default PrivacyCardProviderService;
