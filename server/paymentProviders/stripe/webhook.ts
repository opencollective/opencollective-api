/* eslint-disable camelcase */

import config from 'config';
import debugLib from 'debug';
import { Request } from 'express';
import { get, omit } from 'lodash';
import type Stripe from 'stripe';
import { v4 as uuid } from 'uuid';

import { Service } from '../../constants/connected_account';
import FEATURE from '../../constants/feature';
import OrderStatuses from '../../constants/order_status';
import { PAYMENT_METHOD_TYPE, PAYMENT_METHOD_TYPES } from '../../constants/paymentMethods';
import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import { getFxRate } from '../../lib/currency';
import logger from '../../lib/logger';
import { toNegative } from '../../lib/math';
import {
  createRefundTransaction,
  createSubscription,
  sendEmailNotifications,
  sendOrderFailedEmail,
} from '../../lib/payments';
import stripe from '../../lib/stripe';
import models, { sequelize } from '../../models';
import { OrderModelInterface } from '../../models/Order';
import { PaymentMethodModelInterface } from '../../models/PaymentMethod';

import { getVirtualCardForTransaction } from './../utils';
import { createChargeTransactions, createPaymentMethod } from './common';
import * as virtualcard from './virtual-cards';

const debug = debugLib('stripe');

export async function createOrUpdateOrderStripePaymentMethod(
  order: OrderModelInterface,
  stripeAccount: string,
  paymentIntent: Stripe.PaymentIntent,
): Promise<PaymentMethodModelInterface> {
  const stripePaymentMethodId =
    typeof paymentIntent.payment_method === 'string' ? paymentIntent.payment_method : paymentIntent.payment_method?.id;

  const orderPaymentMethod = await models.PaymentMethod.findByPk(order.PaymentMethodId);
  // order paymentMethod already saved.
  if (orderPaymentMethod?.data?.stripePaymentMethodId === stripePaymentMethodId) {
    return orderPaymentMethod;
  }

  const matchingPaymentMethod = await models.PaymentMethod.findOne({
    where: {
      CollectiveId: order.FromCollectiveId,
      data: {
        stripePaymentMethodId,
        stripeAccount,
      },
    },
  });

  // order payment method already exists, update order with it.
  if (matchingPaymentMethod) {
    await order.update({
      PaymentMethodId: matchingPaymentMethod.id,
    });
    return matchingPaymentMethod;
  }

  const stripePaymentMethod = await stripe.paymentMethods.retrieve(stripePaymentMethodId, {
    stripeAccount,
  });

  const stripeCustomer = stripePaymentMethod.customer
    ? typeof stripePaymentMethod.customer === 'string'
      ? stripePaymentMethod.customer
      : stripePaymentMethod.customer?.id
    : typeof paymentIntent.customer === 'string'
    ? paymentIntent.customer
    : paymentIntent.customer?.id;

  const pm = await createPaymentMethod({
    stripeAccount,
    stripePaymentMethod,
    stripeCustomer,
    originPaymentIntent: paymentIntent,
    CollectiveId: order.FromCollectiveId,
    CreatedByUserId: order.CreatedByUserId,
  });

  await order.update({
    PaymentMethodId: pm.id,
  });

  return pm;
}

export const mandateUpdated = async (event: Stripe.Event) => {
  const stripeAccount = event.account ?? config.stripe.accountId;

  const stripeMandate = event.data.object as Stripe.Mandate;

  const stripePaymentMethodId =
    typeof stripeMandate.payment_method === 'string' ? stripeMandate.payment_method : stripeMandate.payment_method.id;

  await sequelize.transaction(async transaction => {
    const paymentMethod = await models.PaymentMethod.findOne({
      where: {
        data: {
          stripePaymentMethodId,
        },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!paymentMethod) {
      const stripePaymentMethod = await stripe.paymentMethods.retrieve(stripePaymentMethodId, {
        stripeAccount,
      });

      if (!PAYMENT_METHOD_TYPES.includes(stripePaymentMethod.type as PAYMENT_METHOD_TYPE)) {
        return;
      }

      await createPaymentMethod(
        {
          stripePaymentMethod,
          stripeCustomer:
            typeof stripePaymentMethod.customer === 'string'
              ? stripePaymentMethod.customer
              : stripePaymentMethod.customer?.id,
          stripeAccount,
          extraData: {
            stripeMandate,
          },
        },
        { transaction },
      );

      return;
    } else {
      await paymentMethod.update(
        {
          saved: stripeMandate.type === 'multi_use' && stripeMandate.status !== 'inactive',
          data: {
            ...paymentMethod.data,
            stripeMandate,
          },
        },
        {
          transaction,
        },
      );
    }
    return;
  });
};

export const paymentIntentSucceeded = async (event: Stripe.Event) => {
  const stripeAccount = event.account ?? config.stripe.accountId;
  const paymentIntent = event.data.object as Stripe.PaymentIntent;

  let charge = paymentIntent.latest_charge || ((paymentIntent as any).charges?.data?.[0] as Stripe.Charge);
  if (typeof charge === 'string') {
    charge = await stripe.charges.retrieve(charge, { stripeAccount });
  }

  const order = await models.Order.findOne({
    where: {
      data: { paymentIntent: { id: paymentIntent.id } },
    },
    include: [
      { association: 'collective', required: true },
      { association: 'fromCollective', required: true },
      { association: 'createdByUser', required: true },
    ],
  });

  if (!order) {
    logger.debug(`Stripe Webhook: Could not find Order for Payment Intent ${paymentIntent.id}`);
    return;
  }

  // If charge was already processed, ignore event. (Potential edge-case: if the webhook is called while processing a 3DS validation)
  const existingChargeTransaction = await models.Transaction.findOne({
    where: { OrderId: order.id, data: { charge: { id: charge.id } } },
  });
  if (existingChargeTransaction) {
    logger.info(`Stripe Webhook: ${order.id} already processed charge ${charge.id}, ignoring event ${event.id}`);
    return;
  }

  await createOrUpdateOrderStripePaymentMethod(order, stripeAccount, paymentIntent);

  const transaction = await createChargeTransactions(charge, { order });

  // after successful first payment of a recurring subscription where the payment confirmation is async
  // and the subscription is managed by us.
  if (order.interval && !order.SubscriptionId) {
    await createSubscription(order);
  }

  await order.update({
    status: !order.SubscriptionId ? OrderStatuses.PAID : OrderStatuses.ACTIVE,
    processedAt: new Date(),
    data: {
      ...omit(order.data, 'paymentIntent'),
      previousPaymentIntents: [...(order.data.previousPaymentIntents ?? []), paymentIntent],
    },
  });

  if (order.fromCollective?.ParentCollectiveId !== order.collective.id) {
    await order.getOrCreateMembers();
  }

  sendEmailNotifications(order, transaction);
};

export const paymentIntentProcessing = async (event: Stripe.Event) => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;

  const stripeAccount = event.account ?? config.stripe.accountId;

  await sequelize.transaction(async transaction => {
    const order = await models.Order.findOne({
      where: {
        status: [OrderStatuses.NEW, OrderStatuses.PROCESSING, OrderStatuses.ERROR, OrderStatuses.ACTIVE],
        data: { paymentIntent: { id: paymentIntent.id } },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!order) {
      logger.debug(`Stripe Webhook: Could not find Order for Payment Intent ${paymentIntent.id}`);
      return;
    }

    let pm = await models.PaymentMethod.findOne({
      where: {
        data: {
          stripePaymentMethodId: paymentIntent.payment_method,
          stripeAccount,
        },
      },
      transaction,
    });

    if (!pm) {
      const stripePaymentMethod = await stripe.paymentMethods.retrieve(paymentIntent.payment_method as string, {
        stripeAccount,
      });

      const stripeCustomer = stripePaymentMethod.customer
        ? typeof stripePaymentMethod.customer === 'string'
          ? stripePaymentMethod.customer
          : stripePaymentMethod.customer?.id
        : typeof paymentIntent.customer === 'string'
        ? paymentIntent.customer
        : paymentIntent.customer?.id;

      pm = await createPaymentMethod(
        {
          stripePaymentMethod,
          stripeAccount,
          stripeCustomer,
          originPaymentIntent: paymentIntent,
          CollectiveId: order.FromCollectiveId,
          CreatedByUserId: order.CreatedByUserId,
        },
        { transaction },
      );
    }

    await order.update(
      {
        status: OrderStatuses.PROCESSING,
        PaymentMethodId: pm.id,
        data: { ...order.data, paymentIntent },
      },
      { transaction },
    );
  });
};

export const paymentIntentFailed = async (event: Stripe.Event) => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const order = await models.Order.findOne({
    where: {
      data: { paymentIntent: { id: paymentIntent.id } },
    },
    include: [
      { association: 'collective', required: true },
      { association: 'fromCollective', required: true },
      { association: 'createdByUser', required: true },
    ],
  });

  if (!order) {
    logger.debug(`Stripe Webhook: Could not find Order for Payment Intent ${paymentIntent.id}`);
    return;
  }

  const charge = (paymentIntent as any).charges?.data?.[0] as Stripe.Charge;
  const reason = paymentIntent.last_payment_error?.message || charge?.failure_message || 'unknown';
  logger.info(`Stripe Webook: Payment Intent failed for Order #${order.id}. Reason: ${reason}`);

  await order.update({
    status: OrderStatuses.ERROR,
    data: { ...order.data, paymentIntent },
  });

  sendOrderFailedEmail(order, reason);
};

export const chargeDisputeCreated = async (event: Stripe.Event) => {
  const dispute = event.data.object as Stripe.Dispute;
  const chargeTransaction = await models.Transaction.findOne({
    where: { data: { charge: { id: dispute.charge } } },
    include: [
      {
        model: models.User,
        required: true,
        as: 'createdByUser',
      },
    ],
  });

  if (!chargeTransaction) {
    return;
  }

  const user = chargeTransaction.createdByUser;

  const transactions = await models.Transaction.findAll({
    where: {
      TransactionGroup: chargeTransaction.TransactionGroup,
    },
    include: {
      model: models.Order,
      required: true,
      include: [models.Subscription],
    },
  });

  // Block User from creating any new Orders
  await user.limitFeature(FEATURE.ORDER, `Charge disputed for transaction #${chargeTransaction.id}`);

  await Promise.all(
    transactions.map(async transaction => {
      await transaction.update({ isDisputed: true });
      const order = transaction.Order;
      if (order.status !== OrderStatuses.DISPUTED) {
        await order.update({ status: OrderStatuses.DISPUTED });

        if (order.SubscriptionId) {
          await order.Subscription.deactivate();
        }
      }
    }),
  );
};

// Charge dispute has been closed on Stripe (with status of: won/lost/closed)
export const chargeDisputeClosed = async (event: Stripe.Event) => {
  const dispute = event.data.object as Stripe.Dispute;
  const chargeTransaction = await models.Transaction.findOne({
    where: { data: { charge: { id: dispute.charge } }, isDisputed: true, type: TransactionTypes.CREDIT },
    include: [
      {
        model: models.Order,
        required: true,
        include: [models.Subscription],
      },
      {
        model: models.User,
        required: true,
        as: 'createdByUser',
      },
    ],
  });
  if (!chargeTransaction) {
    return;
  }

  const disputeTransaction = await models.Transaction.findOne({
    where: { data: { dispute: { id: dispute.id } } },
  });
  if (disputeTransaction) {
    logger.info(
      `Stripe Webhook: Dispute ${dispute.id} already processed in transaction #${disputeTransaction.id}. Skipping...`,
    );
    return;
  }

  const transactions = await models.Transaction.findAll({
    where: {
      TransactionGroup: chargeTransaction.TransactionGroup,
    },
    include: {
      model: models.Order,
      required: true,
      include: [models.Subscription],
    },
  });

  if (transactions.length > 0) {
    const order = chargeTransaction.Order;

    const disputeStatus = dispute.status;
    const disputeTransaction = dispute.balance_transactions.find(
      tx => tx.type === 'adjustment' && tx.reporting_category === 'dispute',
    );

    // A lost dispute means it was decided as fraudulent
    if (disputeStatus === 'lost') {
      if (order.status === OrderStatuses.DISPUTED) {
        if (order.SubscriptionId) {
          await order.update({ status: OrderStatuses.CANCELLED });
        } else {
          await order.update({ status: OrderStatuses.REFUNDED });
        }
      }

      const paymentMethod = await order.getPaymentMethod();
      if (paymentMethod?.type === PAYMENT_METHOD_TYPE.CREDITCARD) {
        await models.SuspendedAsset.suspendCreditCard(paymentMethod, `CreditCard was disputed in order ${order.id}`);
      }

      // Create refund transaction for the fraudulent charge
      const transactionGroup = uuid();
      await createRefundTransaction(
        chargeTransaction,
        0,
        {
          ...chargeTransaction.data,
          dispute,
          refundTransactionId: chargeTransaction.id,
        },
        null,
        transactionGroup,
      );

      // Create transaction for dispute fee debiting the fiscal host
      const feeDetails = disputeTransaction.fee_details.find(feeDetails => feeDetails.description === 'Dispute fee');
      const currency = feeDetails.currency.toUpperCase();
      const amount = feeDetails.amount;
      const fiscalHost = await models.Collective.findByPk(chargeTransaction.HostCollectiveId);
      const hostCurrencyFxRate = await getFxRate(currency, fiscalHost.currency);
      const hostCurrencyAmount = Math.round(toNegative(amount) * hostCurrencyFxRate);

      await models.Transaction.create({
        type: 'DEBIT',
        HostCollectiveId: fiscalHost.id,
        CollectiveId: fiscalHost.id,
        FromCollectiveId: fiscalHost.id,
        OrderId: chargeTransaction.OrderId,
        TransactionGroup: transactionGroup,
        amount: toNegative(amount),
        netAmountInCollectiveCurrency: toNegative(amount),
        amountInHostCurrency: hostCurrencyAmount,
        currency: currency,
        hostCurrency: fiscalHost.currency,
        description: 'Stripe Transaction Dispute Fee',
        paymentProcessorFeeInHostCurrency: 0,
        hostFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        hostCurrencyFxRate,
        kind: TransactionKind.PAYMENT_PROCESSOR_DISPUTE_FEE,
        data: { dispute },
      });

      // A won dispute means it was decided as not fraudulent
    } else if (disputeStatus === 'won') {
      if (order.status === OrderStatuses.DISPUTED) {
        if (order.SubscriptionId) {
          await order.update({ status: OrderStatuses.ACTIVE });
          await order.Subscription.activate();
        } else {
          await order.update({ status: OrderStatuses.PAID });
        }
      }

      const user = chargeTransaction.createdByUser;
      const userHasDisputedOrders = await user.hasDisputedOrders();
      if (!userHasDisputedOrders) {
        await user.unlimitFeature(FEATURE.ORDER);
      }

      await Promise.all(
        transactions.map(async transaction => {
          await transaction.update({ isDisputed: false });
        }),
      );
    }
  }
};

// Charge on Stripe had a fraud review opened
export const reviewOpened = async (event: Stripe.Event) => {
  const review = event.data.object as Stripe.Review;
  const paymentIntentTransaction = await models.Transaction.findOne({
    // eslint-disable-next-line camelcase
    where: { data: { charge: { payment_intent: review.payment_intent } } },
    include: [
      {
        model: models.Order,
        required: true,
        include: [models.Subscription],
      },
    ],
  });

  if (!paymentIntentTransaction) {
    return;
  }

  const transactions = await models.Transaction.findAll({
    where: {
      TransactionGroup: paymentIntentTransaction.TransactionGroup,
    },
    include: {
      model: models.Order,
      required: true,
      include: [models.Subscription],
    },
  });

  await Promise.all(
    transactions.map(async transaction => {
      await transaction.update({ isInReview: true });
      const order = transaction.Order;
      if (order.status !== OrderStatuses.IN_REVIEW) {
        await order.update({ status: OrderStatuses.IN_REVIEW });

        if (order.SubscriptionId) {
          await order.Subscription.deactivate();
        }
      }
    }),
  );
};

// Charge on Stripe had a fraud review closed (either approved/refunded)
export const reviewClosed = async (event: Stripe.Event) => {
  const review = event.data.object as Stripe.Review;
  const stripePaymentIntentId = review.payment_intent;
  const closedReason = review.closed_reason;

  const paymentIntentTransaction = await models.Transaction.findOne({
    // eslint-disable-next-line camelcase
    where: { data: { charge: { payment_intent: stripePaymentIntentId } } },
    include: [
      {
        model: models.Order,
        required: true,
        include: [models.Subscription],
      },
      {
        model: models.User,
        required: true,
        as: 'createdByUser',
      },
    ],
  });

  if (!paymentIntentTransaction) {
    return;
  }

  const user = paymentIntentTransaction.createdByUser;

  const transactions = await models.Transaction.findAll({
    where: {
      TransactionGroup: paymentIntentTransaction.TransactionGroup,
    },
    include: {
      model: models.Order,
      required: true,
      include: [models.Subscription],
    },
  });

  if (transactions.length > 0) {
    const order = paymentIntentTransaction.Order;

    // closedReasons: approved, refunded, refunded_as_fraud, disputed, redacted
    if (closedReason === 'refunded_as_fraud' || closedReason === 'refunded') {
      if (order.status === OrderStatuses.IN_REVIEW) {
        if (order.SubscriptionId) {
          await order.update({ status: OrderStatuses.CANCELLED, data: { ...order.data, closedReason } });
        } else {
          await order.update({ status: OrderStatuses.REFUNDED, data: { ...order.data, closedReason } });
        }
      }

      // Create refund transaction for the fraudulent charge
      const transactionGroup = uuid();
      await createRefundTransaction(
        paymentIntentTransaction,
        0,
        {
          ...paymentIntentTransaction.data,
          review: event,
          refundTransactionId: paymentIntentTransaction.id,
        },
        null,
        transactionGroup,
      );

      // charge review was determined to be fraudulent
      if (closedReason === 'refunded_as_fraud') {
        await user.limitFeature(
          FEATURE.ORDER,
          `Transactions for group #${paymentIntentTransaction.TransactionGroup} refunded as fraud`,
        );
      } else if (closedReason === 'refunded') {
        await Promise.all(
          transactions.map(async transaction => {
            await transaction.update({ isInReview: false });
          }),
        );
      }
    } else {
      if (order.status === OrderStatuses.IN_REVIEW) {
        if (order.SubscriptionId) {
          await order.update({ status: OrderStatuses.ACTIVE });
          await order.Subscription.activate();
        } else {
          await order.update({ status: OrderStatuses.PAID });
        }
      }

      await Promise.all(
        transactions.map(async transaction => {
          await transaction.update({ isInReview: false });
        }),
      );
    }
  }
};

export async function paymentMethodAttached(event: Stripe.Event) {
  const stripePaymentMethod = event.data.object as Stripe.PaymentMethod;

  if (!['us_bank_account', 'sepa_debit', 'bacs_debit'].includes(stripePaymentMethod.type)) {
    return;
  }

  const stripeAccount = event.account ?? config.stripe.accountId;

  const stripeCustomerId =
    typeof stripePaymentMethod.customer === 'string' ? stripePaymentMethod.customer : stripePaymentMethod.customer?.id;

  await sequelize.transaction(async transaction => {
    const stripeCustomerAccount = await models.ConnectedAccount.findOne({
      where: {
        clientId: stripeAccount,
        username: stripeCustomerId,
        service: Service.STRIPE_CUSTOMER,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!stripeCustomerAccount) {
      return;
    }

    const pm = await models.PaymentMethod.findOne({
      where: {
        data: {
          stripePaymentMethodId: stripePaymentMethod.id,
          stripeAccount,
        },
      },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });

    if (pm) {
      await pm.update(
        {
          customerId: stripeCustomerId,
          CollectiveId: stripeCustomerAccount.CollectiveId,
        },
        {
          transaction,
        },
      );
      return;
    }

    await createPaymentMethod(
      {
        stripeAccount,
        stripeCustomer: stripeCustomerId,
        stripePaymentMethod,
        attachedToCustomer: true,
        CollectiveId: stripeCustomerAccount.CollectiveId,
      },
      {
        transaction,
      },
    );
  });
}

/*
 * Stripe issuing events are currently using account webhooks, meaning
 * that each host with virtual card enabled has an account webhook setup to this endpoint.
 * To validate the webhook we first get the virtual card and associated host.
 * This will be deprecated and unified when these events are migrated to the connect webhook.
 */
async function handleIssuingWebhooks(request: Request<unknown, Stripe.Event>) {
  const event = <Stripe.Event>request.body;

  let virtualCardId;
  if (event.type.startsWith('issuing_authorization')) {
    virtualCardId = (<Stripe.Issuing.Authorization>event.data.object).card.id;
  } else if (event.type.startsWith('issuing_transaction')) {
    const transaction = <Stripe.Issuing.Transaction>event.data.object;
    virtualCardId = get(transaction, 'transaction.card.id', transaction?.card);
  } else if (event.type.startsWith('issuing_card')) {
    virtualCardId = (<Stripe.Issuing.Card>event.data.object).id;
  } else {
    logger.debug(`Stripe: Webhooks: Received an unsupported issuing event type: ${event.type}`);
    return;
  }

  if (!virtualCardId) {
    throw new Error('virtual card id not set in webhook event');
  }

  const virtualCard = await getVirtualCardForTransaction(virtualCardId);
  if (!virtualCard) {
    logger.debug(`Stripe: Webhooks: Received an event for a virtual card that does not exist: ${virtualCardId}`);
    return;
  }

  const stripeClient = await virtualcard.getStripeClient(virtualCard.host);
  const webhookSigningSecret = await virtualcard.getWebhookSigninSecret(virtualCard.host);

  try {
    stripeClient.webhooks.constructEvent(request.rawBody, request.headers['stripe-signature'], webhookSigningSecret);
  } catch {
    throw new Error('Source of event not recognized');
  }

  switch (event.type) {
    case 'issuing_authorization.request':
      return virtualcard.processAuthorization(event);
    case 'issuing_authorization.created':
      if (!(<Stripe.Issuing.Authorization>event.data.object).approved) {
        return virtualcard.processDeclinedAuthorization(event);
      }
      return;
    case 'issuing_authorization.updated':
      return virtualcard.processUpdatedTransaction(event);
    case 'issuing_transaction.created':
      return virtualcard.processTransaction(<Stripe.Issuing.Transaction>event.data.object);
    case 'issuing_card.updated':
      return virtualcard.processCardUpdate(event);
    default:
      logger.debug(`Stripe: Webhooks: Received an unsupported issuing event type: ${event.type}`);
      return;
  }
}

export const webhook = async (request: Request<unknown, Stripe.Event>) => {
  debug(`Stripe webhook event received : ${request.rawBody}`);

  let event = <Stripe.Event>request.body;

  // Stripe sends test events to production as well
  // don't do anything if the event is not livemode
  // NOTE: not using config.env because of ugly tests
  if (process.env.OC_ENV === 'production' && !event.livemode) {
    return Promise.resolve();
  }

  if (event.type.startsWith('issuing')) {
    return handleIssuingWebhooks(request);
  }

  try {
    event = stripe.webhooks.constructEvent(
      request.rawBody,
      request.headers['stripe-signature'],
      config.stripe.webhookSigningSecret,
    );
  } catch (e) {
    throw new Error('Source of event not recognized');
  }

  switch (event.type) {
    case 'charge.dispute.created':
      return chargeDisputeCreated(event);
    // Charge dispute has been closed on Stripe (with status of: won/lost/closed)
    case 'charge.dispute.closed':
      return chargeDisputeClosed(event);
    case 'review.opened':
      return reviewOpened(event);
    case 'review.closed':
      return reviewClosed(event);
    case 'payment_intent.succeeded':
      return paymentIntentSucceeded(event);
    case 'payment_intent.processing':
      return paymentIntentProcessing(event);
    case 'payment_intent.payment_failed':
      return paymentIntentFailed(event);
    case 'payment_method.attached':
      return paymentMethodAttached(event);
    case 'mandate.updated':
      return mandateUpdated(event);
    default:
      // console.log(JSON.stringify(event, null, 4));
      logger.debug(`Stripe: Webhooks: Received an unsupported event type: ${event.type}`);
      return;
  }
};
