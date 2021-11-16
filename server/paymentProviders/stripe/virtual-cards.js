import config from 'config';
import { omit } from 'lodash';
import Stripe from 'stripe';

import ExpenseStatus from '../../constants/expense_status';
import ExpenseType from '../../constants/expense_type';
import { TransactionKind } from '../../constants/transaction-kind';
import { getFxRate } from '../../lib/currency';
import logger from '../../lib/logger';
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

  const cardData = {
    id: matchingCard.id,
    name,
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

export const processAuthorization = async (stripeAuthorization, stripeEvent) => {
  const virtualCard = await getVirtualCardForTransaction(stripeAuthorization.card.id);

  if (!virtualCard) {
    throw new Error(`Virtual card ${stripeAuthorization.card.id} not found`);
  }

  const host = virtualCard.host;

  await checkStripeEvent(host, stripeEvent);

  const amount = stripeAuthorization.amount;
  const balance = await host.getBalanceWithBlockedFundsAmount();
  const connectedAccount = await host.getAccountForPaymentProvider(providerName);
  const stripe = getStripeClient(host.slug, connectedAccount.token);

  if (balance.value >= amount) {
    await stripe.issuing.authorizations.approve(stripeAuthorization.id);
  } else {
    await stripe.issuing.authorizations.decline(stripeAuthorization.id);
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
  const hostCurrencyFxRate = await getFxRate('USD', host.currency);
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

    await models.Transaction.createDoubleEntry({
      // Note that Collective and FromCollective here are inverted because this is the CREDIT transaction
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
  } catch (error) {
    if (expense) {
      await models.Transaction.destroy({ where: { ExpenseId: expense.id } });
      await models.ExpenseItem.destroy({ where: { ExpenseId: expense.id } });
      await expense.destroy();
    }
    throw error;
  }

  return expense;
};

export const processTransaction = async (stripeTransaction, stripeEvent) => {
  const virtualCard = await getVirtualCardForTransaction(stripeTransaction.card);

  if (stripeEvent) {
    await checkStripeEvent(virtualCard.host, stripeEvent);
  }

  const amount = -stripeTransaction.amount;
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
    stripeTransaction.authorization,
  );
};

const checkStripeEvent = async (stripeEvent, host) => {
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
