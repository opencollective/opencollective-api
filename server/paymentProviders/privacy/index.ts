/* eslint-disable camelcase */
import { isEmpty, omit } from 'lodash';

import VirtualCardProviders from '../../constants/virtual_card_providers';
import logger from '../../lib/logger';
import * as privacy from '../../lib/privacy';
import { reportMessageToSentry } from '../../lib/sentry';
import models from '../../models';
import Expense from '../../models/Expense';
import VirtualCardModel from '../../models/VirtualCard';
import { PrivacyVirtualCardLimitIntervalToOCInterval, Transaction } from '../../types/privacy';
import { CardProviderService } from '../types';
import { getVirtualCardForTransaction, persistTransaction } from '../utils';

const providerName = 'privacy';

const processTransaction = async (
  privacyTransaction: Transaction,
  privacyEvent: any,
  options: { card?: VirtualCardModel } = {},
): Promise<Expense | undefined> => {
  const cardToken = privacyTransaction.card_token || privacyTransaction.card.token;
  const virtualCard = options?.card || (await getVirtualCardForTransaction(cardToken));

  if (!virtualCard) {
    logger.error(`Privacy: could not find virtual card ${cardToken}`, privacyEvent);
    reportMessageToSentry('Privacy: could not find virtual card', { extra: { privacyEvent, privacyTransaction } });
    return;
  }

  if (privacyEvent) {
    const host = virtualCard.host;
    const connectedAccount = await host.getAccountForPaymentProvider(providerName);

    privacy.verifyEvent(privacyEvent.signature, privacyEvent.rawBody, connectedAccount.token);
  }

  const amount = privacyTransaction.settled_amount;
  const isRefund = amount < 0;

  return persistTransaction(virtualCard, {
    id: privacyTransaction.token,
    amount,
    vendorProviderId: privacyTransaction.merchant.acceptor_id,
    vendorName: privacyTransaction.merchant.descriptor,
    incurredAt: privacyTransaction.created,
    isRefund,
  });
};

const assignCardToCollective = async (
  cardNumber: string,
  expiryDate: string,
  cvv: string,
  name: string,
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

  return await models.VirtualCard.create({
    id: card.token,
    name,
    last4: card.last_four,
    privateData: { cardNumber, expiryDate, cvv },
    data: omit(card, ['pan', 'cvv', 'exp_year', 'exp_month']),
    CollectiveId: collectiveId,
    HostCollectiveId: host.id,
    UserId: userId,
    provider: VirtualCardProviders.PRIVACY,
    spendingLimitAmount: card['spend_limit'] === 0 ? null : card['spend_limit'],
    spendingLimitInterval: PrivacyVirtualCardLimitIntervalToOCInterval[card['spend_limit_duration']],
  });
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
