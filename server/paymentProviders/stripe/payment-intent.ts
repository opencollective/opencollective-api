import config from 'config';
import { pick, toUpper } from 'lodash';
import type Stripe from 'stripe';

import OrderStatuses from '../../constants/order_status';
import logger from '../../lib/logger';
import { getApplicationFee } from '../../lib/payments';
import { reportMessageToSentry } from '../../lib/sentry';
import stripe, { convertToStripeAmount } from '../../lib/stripe';
import models from '../../models';

import {
  APPLICATION_FEE_INCOMPATIBLE_CURRENCIES,
  createChargeTransactions,
  refundTransaction,
  refundTransactionOnlyInDatabase,
} from './common';

async function processNewOrder(order: typeof models.Order) {
  const hostStripeAccount = await order.collective.getHostStripeAccount();
  const host = await order.collective.getHostCollective();
  const isPlatformRevenueDirectlyCollected = APPLICATION_FEE_INCOMPATIBLE_CURRENCIES.includes(toUpper(host.currency))
    ? false
    : host?.settings?.isPlatformRevenueDirectlyCollected ?? true;
  const applicationFee = await getApplicationFee(order, host);
  const paymentIntentParams: Stripe.PaymentIntentUpdateParams = {
    currency: order.currency,
    amount: convertToStripeAmount(order.currency, order.totalAmount),
    description: order.description,
  };

  if (applicationFee && isPlatformRevenueDirectlyCollected && hostStripeAccount.username !== config.stripe.accountId) {
    // eslint-disable-next-line camelcase
    paymentIntentParams.application_fee_amount = convertToStripeAmount(order.currency, applicationFee);
  }

  try {
    const paymentIntent = await stripe.paymentIntents.update(order.data.paymentIntent.id, paymentIntentParams, {
      stripeAccount: hostStripeAccount.username,
    });
    await order.update({ status: OrderStatuses.PROCESSING, data: { ...order.data, paymentIntent } });
  } catch (e) {
    const sanitizedError = pick(e, ['code', 'message', 'requestId', 'statusCode']);
    const errorMessage = `Error processing Stripe Payment Intent: ${e.message}`;
    logger.error(errorMessage, sanitizedError);
    // Hard-delete the order so we can re-use the existing Payment Intent in the next attempt.
    await order.destroy({ force: true });
    throw new Error(errorMessage);
  }
}

async function processRecurringOrder(order: typeof models.Order) {
  const hostStripeAccount = await order.collective.getHostStripeAccount();
  const host = await order.collective.getHostCollective();
  const isPlatformRevenueDirectlyCollected = APPLICATION_FEE_INCOMPATIBLE_CURRENCIES.includes(toUpper(host.currency))
    ? false
    : host?.settings?.isPlatformRevenueDirectlyCollected ?? true;
  const applicationFee = await getApplicationFee(order, host);
  const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
    currency: order.currency,
    amount: convertToStripeAmount(order.currency, order.totalAmount),
    description: order.description,
  };

  if (applicationFee && isPlatformRevenueDirectlyCollected && hostStripeAccount.username !== config.stripe.accountId) {
    // eslint-disable-next-line camelcase
    paymentIntentParams.application_fee_amount = convertToStripeAmount(order.currency, applicationFee);
  }

  // eslint-disable-next-line camelcase
  paymentIntentParams.payment_method_types = [order.paymentMethod?.type];
  // eslint-disable-next-line camelcase
  paymentIntentParams.payment_method = order.paymentMethod?.data?.stripePaymentMethodId;
  paymentIntentParams.customer = order?.paymentMethod?.customerId;
  paymentIntentParams.metadata = {
    from: order.fromCollective ? `${config.host.website}/${order.fromCollective.slug}` : undefined,
    to: `${config.host.website}/${order.collective.slug}`,
    orderId: order.id,
    chargeNumber: order.Subscription.chargeNumber,
    chargeRetryCount: order.Subscription.chargeRetryCount,
  };

  try {
    let paymentIntent = await stripe.paymentIntents.create(paymentIntentParams, {
      stripeAccount: hostStripeAccount.username,
    });

    order.update({ data: { ...order.data, paymentIntent: { id: paymentIntent.id, status: paymentIntent.status } } });
    await order.save();

    paymentIntent = await stripe.paymentIntents.confirm(paymentIntent.id, {
      stripeAccount: hostStripeAccount.username,
    });

    if (paymentIntent.next_action) {
      const paymentIntentError = new Error('Payment Intent require action');
      paymentIntentError['stripeAccount'] = hostStripeAccount.username;
      paymentIntentError['stripeResponse'] = { paymentIntent };
      throw paymentIntentError;
    }

    if (paymentIntent.status === 'processing') {
      order.data = { ...order.data, paymentIntent };
      order.update({ data: { ...order.data, paymentIntent } });
      await order.save();
      return;
    } else if (paymentIntent.status !== 'succeeded') {
      logger.error('Unknown error with Stripe Payment Intent.');
      logger.error(paymentIntent);
      reportMessageToSentry('Unknown error with Stripe Payment Intent', { extra: { paymentIntent } });
      throw new Error('Something went wrong with the payment, please contact support@opencollective.com.');
    }

    // Recently, Stripe updated their library and removed the 'charges' property in favor of 'latest_charge',
    // but this is something that only makes sense in the LatestApiVersion, and that's not the one we're using.
    const charge = (paymentIntent as any).charges.data[0] as Stripe.Charge;
    return createChargeTransactions(charge, { order });
  } catch (e) {
    const sanitizedError = pick(e, ['code', 'message', 'requestId', 'statusCode']);
    const errorMessage = `Error processing Stripe Payment Intent: ${e.message}`;
    logger.error(errorMessage, sanitizedError);
    // Hard-delete the order so we can re-use the existing Payment Intent in the next attempt.
    throw new Error(errorMessage);
  }
}

const processOrder = async (order: typeof models.Order): Promise<void> => {
  if (order.SubscriptionId) {
    return processRecurringOrder(order);
  }

  return processNewOrder(order);
};

export default {
  features: {
    recurring: true,
    waitToCharge: false,
  },
  processOrder,
  refundTransaction,
  refundTransactionOnlyInDatabase,
};
