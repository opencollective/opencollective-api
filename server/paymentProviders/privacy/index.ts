/* eslint-disable camelcase */
import { isEmpty, omit } from 'lodash';

import activities from '../../constants/activities';
import { types as CollectiveTypes } from '../../constants/collectives';
import ExpenseStatus from '../../constants/expense_status';
import ExpenseType from '../../constants/expense_type';
import { TransactionKind } from '../../constants/transaction-kind';
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
    logger.warn('Virtual Card charge already reconciled, ignoring it.');
    return;
  }

  const host = opts?.host || virtualCard.host;
  const hostCurrencyFxRate = opts?.hostCurrencyFxRate || (await getFxRate('USD', host.currency));
  const amount = privacyTransaction.settled_amount;
  const UserId = virtualCard.UserId || collective.CreatedByUserId || collective.LastEditedByUserId;

  const expense = await sequelize.transaction(async transaction => {
    const slug = privacyTransaction.merchant.acceptor_id.toUpperCase();
    const [vendor] = await models.Collective.findOrCreate({
      where: { slug },
      defaults: { name: privacyTransaction.merchant.descriptor, type: CollectiveTypes.VENDOR },
      transaction,
    });

    const description = `Virtual Card charge: ${vendor.name}`;

    const expense = await models.Expense.create(
      {
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
      },
      { transaction },
    );

    expense.fromCollective = vendor;
    expense.collective = collective;
    return expense;
  });

  if (collective.settings?.ignoreExpenseMissingReceiptAlerts !== true) {
    expense
      .createActivity(
        activities.COLLECTIVE_EXPENSE_MISSING_RECEIPT,
        { id: UserId },
        { ...expense.data, user: virtualCard.user },
      )
      .catch(e => logger.error('An error happened when creating the COLLECTIVE_EXPENSE_MISSING_RECEIPT activity', e));
  }

  return expense;
};

const assignCardToCollective = async (
  cardDetails: {
    cardNumber: string;
    expireDate: string;
    cvv: string;
  },
  collective: any,
  host: any,
  options?: { upsert?: boolean; UserId?: number },
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

  if (!card || (card.pan && card.pan !== cardNumber.replace(/\s\s/gm, ''))) {
    throw new Error('Could not find a Privacy Card matching the submitted card');
  }

  const cardData = {
    id: card.token,
    name: card.memo || card.last_four,
    last4: card.last_four,
    privateData: { cardNumber, expireDate, cvv },
    data: omit(card, ['pan', 'cvv', 'exp_year', 'exp_month']),
    CollectiveId: collective.id,
    HostCollectiveId: host.id,
    UserId: options?.UserId,
  };
  if (options?.upsert) {
    const [virtualCard] = await models.VirtualCard.upsert(cardData);
    return virtualCard;
  } else {
    return await models.VirtualCard.create(cardData);
  }
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
  const newData = omit(card, ['pan', 'cvv', 'exp_year', 'exp_month']);
  await virtualCard.update('data', newData);
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

const autoPauseResumeCard = async (virtualCard: VirtualCardModel) => {
  const pendingExpenses = await virtualCard.getExpensesMissingDetails();
  const hasPendingExpenses = !isEmpty(pendingExpenses);

  if (hasPendingExpenses && virtualCard.data.state == 'OPEN') {
    await pauseCard(virtualCard);
  } else if (!hasPendingExpenses && virtualCard.data.state == 'PAUSED') {
    await resumeCard(virtualCard);
  }
};

const PrivacyCardProviderService = {
  createExpense,
  assignCardToCollective,
  autoPauseResumeCard,
  pauseCard,
  resumeCard,
  deleteCard,
  refreshCardDetails,
} as CardProviderService;

export default PrivacyCardProviderService;
