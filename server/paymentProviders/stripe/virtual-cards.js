import config from 'config';
import { omit, pick } from 'lodash';
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

  // Experimental: dedicated matching for Physical Cards
  for (const card of cards.filter(card => card.type === 'physical')) {
    if (card['exp_month'] === parseInt(expireDate.slice(0, 2)) && card['exp_year'] === parseInt(expireDate.slice(-4))) {
      matchingCard = card;
      break;
    }
  }

  for (const card of cards.filter(card => card.type === 'virtual')) {
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
    currency: host.currency.toLowerCase(),
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

export const updateVirtualCardMonthlyLimit = async (virtualCard, monthlyLimit) => {
  const host = virtualCard.host;
  const connectedAccount = await host.getAccountForPaymentProvider(providerName);
  const stripe = getStripeClient(host.slug, connectedAccount.token);

  return stripe.issuing.cards.update(virtualCard.id, {
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
  });
};

const setCardStatus = async (virtualCard, status = 'canceled' | 'active' | 'inactive') => {
  const host = await virtualCard.getHost();
  const connectedAccount = await host.getAccountForPaymentProvider(providerName);
  const stripe = getStripeClient(host.slug, connectedAccount.token);

  const response = await stripe.issuing.cards.update(virtualCard.id, {
    status,
  });
  const data = { ...virtualCard.data, ...pick(response, ['status']) };
  await virtualCard.update({ data });

  return data;
};

export const deleteCard = async virtualCard => setCardStatus(virtualCard, 'canceled');

export const pauseCard = async virtualCard => setCardStatus(virtualCard, 'inactive');

export const resumeCard = async virtualCard => setCardStatus(virtualCard, 'active');

export const processAuthorization = async (stripeAuthorization, stripeEvent) => {
  const virtualCard = await getVirtualCardForTransaction(stripeAuthorization.card.id);
  if (!virtualCard) {
    logger.error(`Stripe: could not find virtual card ${stripeAuthorization.card.id}`, stripeEvent);
    return;
  }

  const host = virtualCard.host;

  await checkStripeEvent(host, stripeEvent);

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

  const currency = stripeAuthorization.pending_request.currency.toUpperCase();
  const amount = convertToStripeAmount(currency, Math.abs(stripeAuthorization.pending_request.amount));
  const collective = virtualCard.collective;
  const balance = await collective.getBalanceWithBlockedFundsAmount({ currency });
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

  const vendor = await getOrCreateVendor(
    stripeAuthorization['merchant_data']['network_id'],
    stripeAuthorization['merchant_data']['name'],
  );

  const UserId = virtualCard.UserId;
  const description = `Virtual Card charge: ${vendor.name}`;
  const incurredAt = new Date(stripeAuthorization.created * 1000);

  let expense;

  try {
    expense = await models.Expense.create({
      UserId,
      CollectiveId: collective.id,
      FromCollectiveId: vendor.id,
      currency,
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
  if (!virtualCard) {
    logger.error(`Stripe: could not find virtual card ${stripeAuthorization.card.id}`, stripeEvent);
    return;
  }

  const host = virtualCard.host;

  await checkStripeEvent(host, stripeEvent);

  const reason = stripeAuthorization.metadata.oc_decline_code
    ? stripeAuthorization.metadata.oc_decline_code
    : stripeAuthorization.request_history[0].reason;

  return emailLib.send('authorization.declined', virtualCard.user.email, { reason, cardName: virtualCard.name });
};

export const processTransaction = async (stripeTransaction, stripeEvent) => {
  const virtualCard = await getVirtualCardForTransaction(stripeTransaction.card);
  if (!virtualCard) {
    logger.error(`Stripe: could not find virtual card ${stripeTransaction.card.id}`, stripeEvent);
    return;
  }

  if (stripeEvent) {
    await checkStripeEvent(virtualCard.host, stripeEvent);
  }

  const currency = stripeTransaction.currency.toUpperCase();
  const amount = convertToStripeAmount(currency, stripeTransaction.amount);
  const isRefund = stripeTransaction.type === 'refund';

  return persistTransaction(virtualCard, {
    id: stripeTransaction.id,
    amount,
    currency,
    vendorProviderId: stripeTransaction['merchant_data']['network_id'],
    vendorName: stripeTransaction['merchant_data']['name'],
    incurredAt: new Date(stripeTransaction.created * 1000),
    isRefund,
    fromAuthorizationId: stripeTransaction.authorization,
  });
};

export const processUpdatedTransaction = async (stripeAuthorization, stripeEvent) => {
  const virtualCard = await getVirtualCardForTransaction(stripeAuthorization.card.id);
  if (!virtualCard) {
    logger.error(`Stripe: could not find virtual card ${stripeAuthorization.card.id}`, stripeEvent);
    return;
  }

  if (stripeEvent) {
    await checkStripeEvent(virtualCard.host, stripeEvent);
  }

  if (stripeAuthorization.status === 'reversed') {
    const expense = await models.Expense.findOne({
      where: {
        VirtualCardId: virtualCard.id,
        data: { authorizationId: stripeAuthorization.id },
      },
    });

    if (!expense) {
      logger.error(
        `Stripe: could not find expense attached to reversed authorization ${stripeAuthorization.id}`,
        stripeEvent,
      );
      return;
    } else if (expense.status !== ExpenseStatus.CANCELED) {
      await expense.update({ status: ExpenseStatus.CANCELED });
    }
  }
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
    currency: stripeCard.currency.toUpperCase(),
  };

  return models.VirtualCard.create(cardData);
};

export const processCardUpdate = async (stripeCard, stripeEvent) => {
  if (stripeEvent) {
    await checkStripeEvent(virtualCard.host, stripeEvent);
  }

  const virtualCard = await models.VirtualCard.findByPk(stripeCard.id);
  if (!virtualCard) {
    logger.error(`Stripe: could not find virtual card ${stripeCard.id}`, stripeEvent);
    return;
  }

  await virtualCard.update({
    data: omit(stripeCard, ['number', 'cvc', 'exp_year', 'exp_month']),
    spendingLimitAmount: stripeCard['spending_controls']['spending_limits'][0]['amount'],
    spendingLimitInterval: stripeCard['spending_controls']['spending_limits'][0]['interval'].toUpperCase(),
  });

  return virtualCard;
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
