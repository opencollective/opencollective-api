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
import { getConnectedAccountForPaymentProvider } from '../utils';

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

  const existingExpense = await models.Expense.findOne({
    where: {
      VirtualCardId: virtualCard.id,
      data: { id: stripeTransaction.id },
    },
  });
  if (existingExpense) {
    logger.warn(`Virtual Card charge already reconciled, ignoring it: ${stripeTransaction.id}`);
    return;
  }

  const UserId = virtualCard.UserId;
  const isRefund = stripeTransaction.type === 'refund';

  // If it is refund, we'll check if the transaction was already created because there are no expenses created for refunds.
  if (isRefund) {
    const existingTransaction = await models.Transaction.findOne({
      where: {
        CollectiveId: collective.id,
        data: { id: stripeTransaction.id },
      },
    });
    if (existingTransaction) {
      logger.warn(`Virtual Card refund already reconciled, ignoring it: ${stripeTransaction.id}`);
      return;
    }
  }

  let expense;
  try {
    const slug = stripeTransaction['merchant_data']['network_id'].toString().toLowerCase();
    const [vendor] = await models.Collective.findOrCreate({
      where: { slug },
      defaults: { name: stripeTransaction['merchant_data']['name'], type: CollectiveTypes.VENDOR },
    });

    const hostCurrencyFxRate = await getFxRate('USD', host.currency);

    // If it is a refund, we'll just create the transaction pair
    if (isRefund) {
      await models.Transaction.createDoubleEntry({
        CollectiveId: vendor.id,
        FromCollectiveId: collective.id,
        HostCollectiveId: host.id,
        description: `Virtual Card refund: ${vendor.name}`,
        type: 'DEBIT',
        currency: 'USD',
        amount: amount,
        netAmountInCollectiveCurrency: amount,
        hostCurrency: host.currency,
        amountInHostCurrency: Math.round(amount * hostCurrencyFxRate),
        paymentProcessorFeeInHostCurrency: 0,
        hostFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        hostCurrencyFxRate,
        isRefund: true,
        kind: TransactionKind.EXPENSE,
        data: stripeTransaction,
      });
    } else {
      const description = `Virtual Card charge: ${vendor.name}`;

      expense = await models.Expense.create({
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
        incurredAt: stripeTransaction.created,
        data: { ...stripeTransaction, missingDetails: true },
      });

      await models.ExpenseItem.create({
        ExpenseId: expense.id,
        incurredAt: stripeTransaction.created,
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

      expense.fromCollective = vendor;
      expense.collective = collective;
      if (collective.settings?.ignoreExpenseMissingReceiptAlerts !== true) {
        expense.createActivity(
          activities.COLLECTIVE_EXPENSE_MISSING_RECEIPT,
          { id: UserId },
          { ...expense.data, user: virtualCard.user },
        );
      }
    }

    return expense;
  } catch (e) {
    if (expense) {
      await models.Transaction.destroy({ where: { ExpenseId: expense.id } });
      await models.ExpenseItem.destroy({ where: { ExpenseId: expense.id } });
      await expense.destroy();
    }
    throw e;
  }
};

const getStripeClient = (slug, token) => {
  const secretKey = slug === 'opencollective' ? config.stripe.secret : token;
  return Stripe(secretKey);
};
