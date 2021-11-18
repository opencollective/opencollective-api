/* eslint-disable camelcase */
import { isEmpty, omit } from 'lodash';

import * as privacy from '../../lib/privacy';
import models from '../../models';
import VirtualCardModel from '../../models/VirtualCard';
import { Transaction } from '../../types/privacy';
import { CardProviderService } from '../types';
import { getVirtualCardForTransaction, persistTransaction } from '../utils';

const providerName = 'privacy';

const processTransaction = async (
  privacyTransaction: Transaction,
  privacyEvent: any,
): Promise<typeof models.Expense | undefined> => {
  const virtualCard = await getVirtualCardForTransaction(privacyTransaction.card.token);

  if (privacyEvent) {
    const host = virtualCard.host;
    const connectedAccount = await host.getAccountForPaymentProvider(providerName);

    privacy.verifyEvent(privacyEvent.signature, privacyEvent.rawBody, connectedAccount.token);
  }

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
  const connectedAccount = await host.getAccountForPaymentProvider(providerName);

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

const setCardState = async (virtualCard: VirtualCardModel, state: 'OPEN' | 'PAUSED'): Promise<VirtualCardModel> => {
  const host = await models.Collective.findByPk(virtualCard.HostCollectiveId);
  const connectedAccount = await host.getAccountForPaymentProvider(providerName);

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
  const connectedAccount = await host.getAccountForPaymentProvider(providerName);

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
} as CardProviderService;

export default PrivacyCardProviderService;
