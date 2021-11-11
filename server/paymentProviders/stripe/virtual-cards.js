import config from 'config';
import { omit } from 'lodash';
import Stripe from 'stripe';

import activities from '../../constants/activities';
import { types as CollectiveTypes } from '../../constants/collectives';
import ExpenseStatus from '../../constants/expense_status';
import ExpenseType from '../../constants/expense_type';
import { TransactionKind } from '../../constants/transaction-kind';
import { getFxRate } from '../../lib/currency';
import logger from '../../lib/logger';
import models from '../../models';
import { getConnectedAccountForPaymentProvider, persistTransaction } from '../utils';

export const assignCardToCollective = async (cardNumber, expireDate, cvv, collectiveId, host, userId) => {
  const connectedAccount = getConnectedAccountForPaymentProvider(host, 'stripe');

  const stripe = getStripeClient(host.slug, connectedAccount.token);

  const list = await stripe.issuing.cards.list({ last4: cardNumber.slice(-4) });
  const cards = list.data;

  let matchingCard;

  for (const card of cards) {
    const stripeCard = await stripe.issuing.cards.retrieve(card.id, { expand: ['number', 'cvc'] });

    if (
      stripeCard.number === cardNumber &&
      stripeCard.cvc === cvv &&
      stripeCard['exp_month'] === parseInt(expireDate.slice(0, 2)) &&
      stripeCard['exp_year'] === parseInt(expireDate.slice(-4))
    ) {
      matchingCard = stripeCard;
      break;
    }
  }

  if (!matchingCard) {
    throw new Error('Could not find a Stripe Card matching the submitted card');
  }

  const cardData = {
    id: matchingCard.id,
    name: matchingCard.last4,
    last4: matchingCard.last4,
    privateData: { cardNumber, expireDate, cvv },
    data: omit(matchingCard, ['number', 'cvc', 'exp_year', 'exp_month']),
    CollectiveId: collectiveId,
    HostCollectiveId: host.id,
    UserId: userId,
    provider: 'STRIPE',
    spendingLimitAmount: matchingCard['spending_controls']['spending_limits'][0]['amount'],
    spendingLimitInterval: matchingCard['spending_controls']['spending_limits'][0]['interval'].toUpperCase(),
  };

  return await models.VirtualCard.create(cardData);
};

export const processTransaction = async (stripeTransaction, stripeSignature, stripeEventRawBody) => {
  const virtualCard = await models.VirtualCard.findOne({
    where: {
      id: stripeTransaction.card,
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

  const host = virtualCard.host;
  const collective = virtualCard.collective;
  const connectedAccount = getConnectedAccountForPaymentProvider(host, 'stripe');
  const stripe = getStripeClient(host.slug, connectedAccount.token);

  try {
    stripe.webhooks.constructEvent(stripeEventRawBody, stripeSignature, connectedAccount.data.stripeEndpointSecret);
  } catch {
    throw new Error('Source of event not recognized');
  }

  const amount = -stripeTransaction.amount;

  if (amount === 0) {
    return;
  }

  const isRefund = stripeTransaction.type === 'refund';

  return persistTransaction(
    virtualCard,
    amount,
    stripeTransaction['merchant_data']['network_id'],
    stripeTransaction['merchant_data']['name'],
    stripeTransaction.created,
    stripeTransaction.id,
    stripeTransaction,
    isRefund,
  );
};

const getStripeClient = (slug, token) => {
  const secretKey = slug === 'opencollective' ? config.stripe.secret : token;
  return Stripe(secretKey);
};
