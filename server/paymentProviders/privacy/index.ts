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
import {
  getConnectedAccountForPaymentProvider,
  persistTransaction,
  getVirtualCardForTransaction
} from '../utils';

const processTransaction = async (
  privacyTransaction: Transaction,
): Promise<typeof models.Expense | undefined> => {
  const virtualCard = await getVirtualCardForTransaction(privacyTransaction.card.token);
  const amount = privacyTransaction.settled_amount;
  const isRefund = amount < 0;

  return persistTransaction(
    virtualCard,
    amount,
    privacyTransaction.merchant.acceptor_id,
    privacyTransaction.merchant.descriptor,
    privacyTransaction.created,
    privacyTransaction.token,
    privacyTransaction,
    isRefund,
  );
};

const assignCardToCollective = async (
  cardNumber: string,
  expireDate: string,
  cvv: string,
  collectiveId: number,
  host: any,
  userId: number,
): Promise<VirtualCardModel> => {
  const connectedAccount = getConnectedAccountForPaymentProvider(host, 'privacy');

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
  const host = await models.Collective.findByPk(virtualCard.HostCollectiveId);
  const connectedAccount = getConnectedAccountForPaymentProvider(host, 'privacy');

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
  const connectedAccount = getConnectedAccountForPaymentProvider(host, 'privacy');

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
  const connectedAccount = getConnectedAccountForPaymentProvider(host, 'privacy');

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
