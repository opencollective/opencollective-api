import { omit, pick } from 'lodash';
import moment from 'moment';
import type Stripe from 'stripe';

import { activities } from '../../constants';
import { SupportedCurrency } from '../../constants/currencies';
import ExpenseStatus from '../../constants/expense-status';
import ExpenseType from '../../constants/expense-type';
import VirtualCardProviders from '../../constants/virtual-card-providers';
import { VirtualCardLimitIntervals } from '../../constants/virtual-cards';
import { isSupportedCurrency } from '../../lib/currency';
import logger from '../../lib/logger';
import { reportMessageToSentry } from '../../lib/sentry';
import stripe, { convertToStripeAmount, StripeCustomToken } from '../../lib/stripe';
import models from '../../models';
import VirtualCard from '../../models/VirtualCard';
import { getOrCreateVendor, getVirtualCardForTransaction, persistVirtualCardTransaction } from '../utils';

export const assignCardToCollective = async (cardNumber, expiryDate, cvv, name, collectiveId, host, userId) => {
  const stripe = await getStripeClient(host);

  const list = await stripe.issuing.cards.list({ last4: cardNumber.slice(-4) });
  const cards = list.data;

  let matchingCard;

  // Experimental: dedicated matching for Physical Cards
  for (const card of cards.filter(card => card.type === 'physical')) {
    if (card['exp_month'] === parseInt(expiryDate.slice(0, 2)) && card['exp_year'] === parseInt(expiryDate.slice(-4))) {
      matchingCard = card;
      break;
    }
  }

  for (const card of cards.filter(card => card.type === 'virtual')) {
    const stripeCard = await stripe.issuing.cards.retrieve(card.id, { expand: ['number', 'cvc'] });

    if (
      stripeCard.number === cardNumber &&
      stripeCard.cvc === cvv &&
      stripeCard['exp_month'] === parseInt(expiryDate.slice(0, 2)) &&
      stripeCard['exp_year'] === parseInt(expiryDate.slice(-4))
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

export const createVirtualCard = async (
  host,
  collective,
  userId,
  name,
  limitAmount,
  limitInterval = VirtualCardLimitIntervals.MONTHLY,
  virtualCardRequestId = null,
) => {
  const stripe = await getStripeClient(host);

  const cardholders = await stripe.issuing.cardholders.list({ type: 'company', status: 'active' });

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
          amount: limitAmount,
          interval: <Stripe.Issuing.CardUpdateParams.SpendingControls.SpendingLimit.Interval>(
            limitInterval.toLowerCase()
          ),
        },
      ],
    },
    metadata: {
      collective: collective.slug,
    },
  });

  const stripeCard = await stripe.issuing.cards.retrieve(issuingCard.id, { expand: ['number', 'cvc'] });

  return createCard(stripeCard, name, collective.id, host.id, userId, virtualCardRequestId);
};

export const updateVirtualCardLimit = async (
  virtualCard,
  limitAmount,
  limitInterval = VirtualCardLimitIntervals.MONTHLY,
) => {
  const host = virtualCard.host;
  const stripe = await getStripeClient(host);

  return stripe.issuing.cards.update(virtualCard.id, {
    // eslint-disable-next-line camelcase
    spending_controls: {
      // eslint-disable-next-line camelcase
      spending_limits: [
        {
          amount: limitAmount,
          interval: <Stripe.Issuing.CardUpdateParams.SpendingControls.SpendingLimit.Interval>(
            limitInterval.toLowerCase()
          ),
        },
      ],
    },
  });
};

const setCardStatus = async (virtualCard: VirtualCard, status: Stripe.Issuing.CardUpdateParams.Status) => {
  const host = await virtualCard.getHost();
  const stripe = await getStripeClient(host);

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

export const processAuthorization = async (event: Stripe.Event) => {
  const stripeAuthorization = <Stripe.Issuing.Authorization>event.data.object;
  const virtualCard = await getVirtualCardForTransaction(stripeAuthorization.card.id);
  if (!virtualCard) {
    logger.error(`Stripe: could not find virtual card ${stripeAuthorization.card.id}`);
    reportMessageToSentry('Stripe: could not find virtual card', { extra: { event } });
    return;
  }

  const host = virtualCard.host;

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

  const currency = stripeAuthorization.pending_request.currency.toUpperCase() as SupportedCurrency;
  if (!isSupportedCurrency(currency)) {
    reportMessageToSentry('Unsupported currency for Stripe Virtual Card', { extra: { currency, event } });
  }

  const amount = convertToStripeAmount(currency, Math.abs(stripeAuthorization.pending_request.amount));
  const collective = virtualCard.collective;
  const balance = await collective.getBalanceAmount({ currency, withBlockedFunds: true });
  const stripe = await getStripeClient(host);

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
      currency,
    });

    const user = virtualCard.user;

    await models.Activity.create({
      type: activities.VIRTUAL_CARD_PURCHASE,
      CollectiveId: collective.id,
      UserId: user.id,
      ExpenseId: expense.id,
      data: {
        VirtualCardId: virtualCard.id,
        collective: collective.activity,
        expense: expense.info,
        amount,
        currency,
      },
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

export const processDeclinedAuthorization = async (event: Stripe.Event) => {
  const stripeAuthorization = <Stripe.Issuing.Authorization>event.data.object;
  const virtualCard = await getVirtualCardForTransaction(stripeAuthorization.card.id);
  if (!virtualCard) {
    logger.error(`Stripe: could not find virtual card ${stripeAuthorization.card.id}`, event);
    reportMessageToSentry('Stripe: could not find virtual card', { extra: { stripeAuthorization, event } });
    return;
  }

  const host = virtualCard.host;
  const reason = stripeAuthorization.metadata.oc_decline_code
    ? stripeAuthorization.metadata.oc_decline_code
    : stripeAuthorization.request_history[0].reason;

  await models.Activity.create({
    type: activities.VIRTUAL_CARD_CHARGE_DECLINED,
    CollectiveId: virtualCard.CollectiveId,
    HostCollectiveId: host.id,
    UserId: virtualCard.UserId,
    data: { reason, cardName: virtualCard.name, isSystem: true },
  });
};

export const processTransaction = async (stripeTransaction: Stripe.Issuing.Transaction) => {
  const virtualCard = await getVirtualCardForTransaction(stripeTransaction.card);
  if (!virtualCard) {
    logger.error(
      `Stripe: could not find virtual card ${
        typeof stripeTransaction.card === 'string' ? stripeTransaction.card : stripeTransaction.card.id
      }`,
      event,
    );
    reportMessageToSentry('Stripe: could not find virtual card', { extra: { stripeTransaction, event } });
    return;
  }

  const currency = stripeTransaction.currency.toUpperCase();
  const amount = convertToStripeAmount(currency, stripeTransaction.amount);
  const isRefund = stripeTransaction.type === 'refund';
  const clearedAt = moment.unix(stripeTransaction.created).toDate();

  return persistVirtualCardTransaction(virtualCard, {
    id: stripeTransaction.id,
    amount,
    currency,
    vendorProviderId: stripeTransaction['merchant_data']['network_id'],
    vendorName: stripeTransaction['merchant_data']['name'],
    clearedAt,
    incurredAt: clearedAt,
    isRefund,
    fromAuthorizationId: stripeTransaction.authorization,
    data: { transaction: stripeTransaction },
  });
};

export const processUpdatedTransaction = async (event: Stripe.Event) => {
  const stripeAuthorization = <Stripe.Issuing.Authorization>event.data.object;
  const virtualCard = await getVirtualCardForTransaction(stripeAuthorization.card.id);
  if (!virtualCard) {
    logger.error(`Stripe: could not find virtual card ${stripeAuthorization.card.id}`, event);
    reportMessageToSentry('Stripe: could not find virtual card', { extra: { stripeAuthorization, event } });
    return;
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
        event,
      );
      reportMessageToSentry('Stripe: could not find expense attached to reversed authorization', {
        extra: { stripeAuthorization, event },
      });
      return;
    } else if (expense.status !== ExpenseStatus.CANCELED) {
      await expense.update({ status: ExpenseStatus.CANCELED });
    }
  }
};

const createCard = (stripeCard, name, collectiveId, hostId, userId, VirtualCardRequestId = null) => {
  const cardData = {
    id: stripeCard.id,
    name,
    last4: stripeCard.last4,
    privateData: {
      cardNumber: stripeCard.number,
      expiryDate: `${stripeCard['exp_month']}/${stripeCard['exp_year']}`,
      cvv: stripeCard.cvc,
    },
    data: omit(stripeCard, ['number', 'cvc', 'exp_year', 'exp_month']),
    CollectiveId: collectiveId,
    HostCollectiveId: hostId,
    UserId: userId,
    VirtualCardRequestId,
    provider: VirtualCardProviders.STRIPE,
    spendingLimitAmount: stripeCard['spending_controls']['spending_limits'][0]['amount'],
    spendingLimitInterval: stripeCard['spending_controls']['spending_limits'][0]['interval'].toUpperCase(),
    currency: stripeCard.currency.toUpperCase(),
  };

  return models.VirtualCard.create(cardData);
};

export const processCardUpdate = async (event: Stripe.Event) => {
  const stripeCard = <Stripe.Issuing.Card>event.data.object;
  const virtualCard = await models.VirtualCard.findByPk(stripeCard.id, { include: ['host'] });
  if (!virtualCard) {
    logger.error(`Stripe: could not find virtual card ${stripeCard.id}`, event);
    reportMessageToSentry('Stripe: could not find virtual card', { extra: { stripeCard, event } });
    return;
  }

  await virtualCard.update({
    data: omit(stripeCard, ['number', 'cvc', 'exp_year', 'exp_month']),
    spendingLimitAmount: stripeCard['spending_controls']['spending_limits'][0]['amount'],
    spendingLimitInterval: stripeCard['spending_controls']['spending_limits'][0]['interval'].toUpperCase(),
  });

  return virtualCard;
};

export const getStripeClient = async host => {
  if (host.slug === 'opencollective') {
    return stripe;
  }

  const connectedAccount = await host.getAccountForPaymentProvider('stripe');

  return StripeCustomToken(connectedAccount.token);
};

export const getWebhookSigninSecret = async host => {
  const connectedAccount = await host.getAccountForPaymentProvider('stripe');
  if (!connectedAccount) {
    throw new Error('Stripe not connected for Host');
  }

  if (!connectedAccount.data?.webhookSigningSecret && !connectedAccount.data?.stripeEndpointSecret) {
    throw new Error('Stripe Webhook Signin Secret not set for Host');
  }
  return connectedAccount.data?.webhookSigningSecret || connectedAccount.data.stripeEndpointSecret;
};
