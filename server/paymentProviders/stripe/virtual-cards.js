import config from 'config';
import { omit } from 'lodash';
import Stripe from 'stripe';

import ExpenseStatus from '../../constants/expense_status';
import ExpenseType from '../../constants/expense_type';
import emailLib from '../../lib/email';
import logger from '../../lib/logger';
import { convertToStripeAmount } from '../../lib/stripe';
import models from '../../models';
import { getOrCreateVendor, getVirtualCardForTransaction, persistTransaction } from '../utils';

const providerName = 'stripe';

export const assignCardToCollective = async (cardNumber, expireDate, cvv, name, collectiveId, host, userId) => {
  const connectedAccount = await host.getAccountForPaymentProvider(providerName);

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

  return createCard(matchingCard, name, collectiveId, host.id, userId);
};

export const createVirtualCard = async (host, collective, userId, name, monthlyLimit) => {
  const connectedAccount = await host.getAccountForPaymentProvider(providerName);

  const stripe = getStripeClient(host.slug, connectedAccount.token);

  const cardholders = await stripe.issuing.cardholders.list();

  if (cardholders.data.length === 0) {
    throw new Error(`No cardholder for account ${host.slug}`);
  }

  const issuingCard = await stripe.issuing.cards.create({
    cardholder: cardholders.data[0].id,
    currency: 'usd',
    type: 'virtual',
    status: 'active',
    // eslint-disable-next-line camelcase
    spending_controls: {
      // eslint-disable-next-line camelcase
      spending_limits: [
        {
          amount: monthlyLimit,
          interval: 'monthly',
        },
      ],
    },
    metadata: {
      collective: collective.slug,
    },
  });

  const stripeCard = await stripe.issuing.cards.retrieve(issuingCard.id, { expand: ['number', 'cvc'] });

  return createCard(stripeCard, name, collective.id, host.id, userId);
};

export const processAuthorization = async (stripeAuthorization, stripeEvent) => {
  const virtualCard = await getVirtualCardForTransaction(stripeAuthorization.card.id);

  const host = virtualCard.host;

  await checkStripeEvent(host, stripeEvent);

  // TODO : convert balance to the same currency as amount
  const amount = convertToStripeAmount(host.currency, stripeAuthorization.amount);
  const balance = await host.getBalanceWithBlockedFundsAmount();
  const connectedAccount = await host.getAccountForPaymentProvider(providerName);
  const stripe = getStripeClient(host.slug, connectedAccount.token);

  if (balance.value >= amount) {
    await stripe.issuing.authorizations.approve(stripeAuthorization.id);
  } else {
    await stripe.issuing.authorizations.decline(stripeAuthorization.id, {
      // eslint-disable-next-line camelcase
      metadata: { oc_decline_code: 'collective_balance' },
    });
    throw new Error('Balance not sufficient');
  }

  const existingExpense = await models.Expense.findOne({
    where: {
      VirtualCardId: virtualCard.id,
      data: { authorizationId: stripeAuthorization.id },
    },
  });

  if (existingExpense) {
    logger.warn(`Virtual Card authorization already reconciled, ignoring it: ${stripeAuthorization.id}`);
    return;
  }

  const vendor = await getOrCreateVendor(
    stripeAuthorization['merchant_data']['network_id'],
    stripeAuthorization['merchant_data']['name'],
  );
  const UserId = virtualCard.UserId;
  const collective = virtualCard.collective;
  const description = `Virtual Card charge: ${vendor.name}`;
  const incurredAt = stripeAuthorization.created;

  let expense;

  try {
    expense = await models.Expense.create({
      UserId,
      CollectiveId: collective.id,
      FromCollectiveId: vendor.id,
      currency: 'USD',
      amount,
      description,
      VirtualCardId: virtualCard.id,
      lastEditedById: UserId,
      status: ExpenseStatus.PROCESSING,
      type: ExpenseType.CHARGE,
      incurredAt,
      data: { authorizationId: stripeAuthorization.id },
    });

    await models.ExpenseItem.create({
      ExpenseId: expense.id,
      incurredAt,
      CreatedByUserId: UserId,
      amount,
    });
  } catch (error) {
    if (expense) {
      await models.ExpenseItem.destroy({ where: { ExpenseId: expense.id } });
      await expense.destroy();
    }
    throw error;
  }

  return expense;
};

export const processDeclinedAuthorization = async (stripeAuthorization, stripeEvent) => {
  const virtualCard = await getVirtualCardForTransaction(stripeAuthorization.card.id);

  const host = virtualCard.host;

  await checkStripeEvent(host, stripeEvent);

  const reason = stripeAuthorization.metadata.oc_decline_code
    ? stripeAuthorization.metadata.oc_decline_code
    : stripeAuthorization.request_history[0].reason;

  return emailLib.send('authorization.declined', virtualCard.user.email, { reason });
};

export const processTransaction = async (stripeTransaction, stripeEvent) => {
  const virtualCard = await getVirtualCardForTransaction(stripeTransaction.card);

  if (stripeEvent) {
    await checkStripeEvent(virtualCard.host, stripeEvent);
  }

  const amount = -convertToStripeAmount(virtualCard.host.currency, stripeTransaction.amount);
  const isRefund = stripeTransaction.type === 'refund';

  return persistTransaction(virtualCard, {
    id: stripeTransaction.id,
    amount,
    vendorProviderId: stripeTransaction['merchant_data']['network_id'],
    vendorName: stripeTransaction['merchant_data']['name'],
    incurredAt: stripeTransaction.created,
    isRefund,
    fromAuthorizationId: stripeTransaction.authorization,
  });
};

const createCard = (stripeCard, name, collectiveId, hostId, userId) => {
  const cardData = {
    id: stripeCard.id,
    name,
    last4: stripeCard.last4,
    privateData: {
      cardNumber: stripeCard.number,
      expireDate: `${stripeCard['exp_month']}/${stripeCard['exp_year']}`,
      cvv: stripeCard.cvc,
    },
    data: omit(stripeCard, ['number', 'cvc', 'exp_year', 'exp_month']),
    CollectiveId: collectiveId,
    HostCollectiveId: hostId,
    UserId: userId,
    provider: 'STRIPE',
    spendingLimitAmount: stripeCard['spending_controls']['spending_limits'][0]['amount'],
    spendingLimitInterval: stripeCard['spending_controls']['spending_limits'][0]['interval'].toUpperCase(),
  };

  return models.VirtualCard.create(cardData);
};

const checkStripeEvent = async (host, stripeEvent) => {
  const connectedAccount = await host.getAccountForPaymentProvider(providerName);
  const stripe = getStripeClient(host.slug, connectedAccount.token);

  try {
    stripe.webhooks.constructEvent(
      stripeEvent.rawBody,
      stripeEvent.signature,
      connectedAccount.data.stripeEndpointSecret,
    );
  } catch {
    throw new Error('Source of event not recognized');
  }
};

const getStripeClient = (slug, token) => {
  const secretKey = slug === 'opencollective' ? config.stripe.secret : token;
  return Stripe(secretKey);
};
