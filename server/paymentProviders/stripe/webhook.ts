/* eslint-disable camelcase */

import config from 'config';
import debugLib from 'debug';
import { Request } from 'express';
import type Stripe from 'stripe';
import { v4 as uuid } from 'uuid';

import { Service } from '../../constants/connected_account';
import FEATURE from '../../constants/feature';
import OrderStatuses from '../../constants/order_status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../constants/paymentMethods';
import { TransactionKind } from '../../constants/transaction-kind';
import { getFxRate } from '../../lib/currency';
import errors from '../../lib/errors';
import logger from '../../lib/logger';
import { toNegative } from '../../lib/math';
import { createRefundTransaction, sendEmailNotifications, sendOrderFailedEmail } from '../../lib/payments';
import stripe from '../../lib/stripe';
import models, { sequelize } from '../../models';

import { createChargeTransactions } from './common';
import * as virtualcard from './virtual-cards';

const debug = debugLib('stripe');

export const paymentIntentSucceeded = async (event: Stripe.Response<Stripe.Event>) => {
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
    logger.warn(`Stripe Webhook: Could not find Order for Payment Intent ${paymentIntent.id}`);
    return;
  }

  // Recently, Stripe updated their library and removed the 'charges' property in favor of 'latest_charge',
  // but this is something that only makes sense in the LatestApiVersion, and that's not the one we're using.
  const charge = (paymentIntent as any).charges.data[0] as Stripe.Charge;
  const transaction = await createChargeTransactions(charge, { order });

  await order.update({
    status: OrderStatuses.PAID,
    processedAt: new Date(),
    data: { ...order.data, paymentIntent },
  });

  if (order.fromCollective?.ParentCollectiveId !== order.collective.id) {
    await order.getOrCreateMembers();
  }

  sendEmailNotifications(order, transaction);
};

export const paymentIntentProcessing = async (event: Stripe.Response<Stripe.Event>) => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;

  const stripeAccount = event.account ?? config.stripe.accountId;

  await sequelize.transaction(async transaction => {
    const order = await models.Order.findOne({
      where: {
        status: [OrderStatuses.NEW, OrderStatuses.PROCESSING],
        data: { paymentIntent: { id: paymentIntent.id } },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!order) {
      logger.warn(`Stripe Webhook: Could not find Order for Payment Intent ${paymentIntent.id}`);
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

      pm = await models.PaymentMethod.create(
        {
          name: formatPaymentMethodName(stripePaymentMethod),
          customerId: paymentIntent.customer,
          CollectiveId: order.FromCollectiveId,
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          type: stripePaymentMethod.type,
          confirmedAt: new Date(),
          saved: paymentIntent.setup_future_usage === 'off_session',
          data: {
            stripePaymentMethodId: paymentIntent.payment_method,
            stripeAccount,
            ...stripePaymentMethod[stripePaymentMethod.type],
          },
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

export const paymentIntentFailed = async (event: Stripe.Response<Stripe.Event>) => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const order = await models.Order.findOne({
    where: {
      status: OrderStatuses.PROCESSING,
      data: { paymentIntent: { id: paymentIntent.id } },
    },
    include: [
      { association: 'collective', required: true },
      { association: 'fromCollective', required: true },
      { association: 'createdByUser', required: true },
    ],
  });

  if (!order) {
    logger.warn(`Stripe Webhook: Could not find Order for Payment Intent ${paymentIntent.id}`);
    return;
  }
  const reason = paymentIntent.last_payment_error.message;
  logger.info(`Stripe Webook: Payment Intent failed for Order #${order.id}. Reason: ${reason}`);

  await order.update({
    status: OrderStatuses.ERROR,
    data: { ...order.data, paymentIntent },
  });

  sendOrderFailedEmail(order, reason);
};

export const chargeDisputeCreated = async (event: Stripe.Response<Stripe.Event>) => {
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
  await user.limitFeature(FEATURE.ORDER);

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
export const chargeDisputeClosed = async (event: Stripe.Response<Stripe.Event>) => {
  const dispute = event.data.object as Stripe.Dispute;
  const chargeTransaction = await models.Transaction.findOne({
    where: { data: { charge: { id: dispute.charge } }, isDisputed: true },
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
          dispute: event,
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
        data: event.data,
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
export const reviewOpened = async (event: Stripe.Response<Stripe.Event>) => {
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
export const reviewClosed = async (event: Stripe.Response<Stripe.Event>) => {
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
          await order.update({ status: OrderStatuses.CANCELLED });
        } else {
          await order.update({ status: OrderStatuses.REFUNDED });
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
        await user.limitFeature(FEATURE.ORDER);
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

function formatPaymentMethodName(paymentMethod: Stripe.PaymentMethod) {
  switch (paymentMethod.type) {
    case PAYMENT_METHOD_TYPE.US_BANK_ACCOUNT: {
      return `${paymentMethod.us_bank_account.bank_name} ****${paymentMethod.us_bank_account.last4}`;
    }
    case PAYMENT_METHOD_TYPE.SEPA_DEBIT: {
      return `${paymentMethod.sepa_debit.bank_code} ****${paymentMethod.sepa_debit.last4}`;
    }
    default: {
      return '';
    }
  }
}

async function paymentMethodAttached(event: Stripe.Response<Stripe.Event>) {
  const stripePaymentMethod = event.data.object as Stripe.PaymentMethod;

  const stripeAccount = event.account ?? config.stripe.accountId;

  const stripeCustomerId = stripePaymentMethod.customer;

  await sequelize.transaction(async transaction => {
    const stripeCustomerAccount = await models.ConnectedAccount.findOne({
      where: {
        clientId: stripeAccount,
        username: stripeCustomerId as string,
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
      transaction,
    });

    if (pm) {
      return;
    }

    await models.PaymentMethod.create(
      {
        name: formatPaymentMethodName(stripePaymentMethod),
        customerId: stripeCustomerId,
        CollectiveId: stripeCustomerAccount.CollectiveId,
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: stripePaymentMethod.type,
        confirmedAt: new Date(),
        saved: true,
        data: {
          stripePaymentMethodId: stripePaymentMethod.id,
          stripeAccount,
          ...stripePaymentMethod[stripePaymentMethod.type],
        },
      },
      { transaction },
    );
  });
}

export const webhook = async (request: Request<unknown, Stripe.Event>) => {
  const requestBody = request.body;

  debug(`Stripe webhook event received : ${request.rawBody}`);

  // Stripe sends test events to production as well
  // don't do anything if the event is not livemode
  // NOTE: not using config.env because of ugly tests
  if (process.env.OC_ENV === 'production' && !requestBody.livemode) {
    return Promise.resolve();
  }

  const stripeEvent = {
    signature: request.headers['stripe-signature'],
    rawBody: request.rawBody,
  };

  if (requestBody.type === 'issuing_authorization.request') {
    return virtualcard.processAuthorization(requestBody.data.object, stripeEvent);
  }

  if (requestBody.type === 'issuing_authorization.created' && !requestBody.data.object.approved) {
    return virtualcard.processDeclinedAuthorization(requestBody.data.object, stripeEvent);
  }

  if (requestBody.type === 'issuing_authorization.updated') {
    return virtualcard.processUpdatedTransaction(requestBody.data.object, stripeEvent);
  }

  if (requestBody.type === 'issuing_transaction.created') {
    return virtualcard.processTransaction(requestBody.data.object, stripeEvent);
  }

  if (requestBody.type === 'issuing_card.updated') {
    return virtualcard.processCardUpdate(requestBody.data.object, stripeEvent);
  }

  /**
   * We check the event on stripe directly to be sure we don't get a fake event from
   * someone else
   */
  // TODO: Change to https://stripe.com/docs/webhooks/signatures#verify-official-libraries
  //       to verify the signature without having to make another call to Stripe?
  return stripe.events
    .retrieve(requestBody.id, { stripeAccount: requestBody.user_id })
    .then((event: Stripe.Response<Stripe.Event>) => {
      if (!event || (event && !event.type)) {
        throw new errors.BadRequest('Event not found');
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
        default:
          // console.log(JSON.stringify(event, null, 4));
          logger.warn(`Stripe: Webhooks: Received an unsupported event type: ${event.type}`);
          return;
      }
    });
};
