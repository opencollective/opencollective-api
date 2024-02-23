import config from 'config';
import { pick, toUpper } from 'lodash';
import type Stripe from 'stripe';

import { Service } from '../../constants/connected-account';
import logger from '../../lib/logger';
import { getApplicationFee } from '../../lib/payments';
import { reportMessageToSentry } from '../../lib/sentry';
import stripe, { convertToStripeAmount } from '../../lib/stripe';
import models from '../../models';
import { OrderModelInterface } from '../../models/Order';
import { PaymentProviderService } from '../types';

import { APPLICATION_FEE_INCOMPATIBLE_CURRENCIES, refundTransaction, refundTransactionOnlyInDatabase } from './common';

const processOrder = async (order: OrderModelInterface): Promise<void> => {
  if (order.SubscriptionId) {
    return processRecurringOrder(order);
  }

  return processNewOrder(order);
};

async function processNewOrder(order: OrderModelInterface) {
  const hostStripeAccount = await order.collective.getHostStripeAccount();
  const host = await order.collective.getHostCollective();
  const isPlatformRevenueDirectlyCollected =
    host && APPLICATION_FEE_INCOMPATIBLE_CURRENCIES.includes(toUpper(host.currency))
      ? false
      : host?.settings?.isPlatformRevenueDirectlyCollected ?? true;
  const applicationFee = await getApplicationFee(order, { host });
  const paymentIntentParams: Stripe.PaymentIntentUpdateParams = {
    currency: order.currency,
    amount: convertToStripeAmount(order.currency, order.totalAmount),
    description: order.description,
  };

  const isPlatformHost = hostStripeAccount.username === config.stripe.accountId;
  const isSavePaymentMethod = order.data?.savePaymentMethod || order.interval;

  if (applicationFee && isPlatformRevenueDirectlyCollected && !isPlatformHost) {
    // eslint-disable-next-line camelcase
    paymentIntentParams.application_fee_amount = convertToStripeAmount(order.currency, applicationFee);
  }

  if (isSavePaymentMethod) {
    // eslint-disable-next-line camelcase
    paymentIntentParams.setup_future_usage = 'off_session';
  }

  let stripeCustomerAccount = await order.fromCollective.getCustomerStripeAccount(hostStripeAccount.username);
  if (isSavePaymentMethod && !stripeCustomerAccount) {
    const customer = await stripe.customers.create(
      {
        email: order.createdByUser.email,
        description: `${config.host.website}/${order.fromCollective.slug}`,
      },
      !isPlatformHost
        ? {
            stripeAccount: hostStripeAccount.username,
          }
        : undefined,
    );

    stripeCustomerAccount = await models.ConnectedAccount.create({
      clientId: hostStripeAccount.username,
      username: customer.id,
      CollectiveId: order.fromCollective.id,
      service: Service.STRIPE_CUSTOMER,
    });

    paymentIntentParams.customer = stripeCustomerAccount.username;
  } else if (stripeCustomerAccount) {
    paymentIntentParams.customer = stripeCustomerAccount.username;
  }

  try {
    const paymentIntent = await stripe.paymentIntents.update(order.data.paymentIntent.id, paymentIntentParams, {
      stripeAccount: hostStripeAccount.username,
    });
    await order.update({ data: { ...order.data, paymentIntent } });
  } catch (e) {
    const sanitizedError = pick(e, ['code', 'message', 'requestId', 'statusCode']);
    const errorMessage = `Error processing Stripe Payment Intent: ${e.message}`;
    logger.error(errorMessage, sanitizedError);
    // Hard-delete the order so we can re-use the existing Payment Intent in the next attempt.
    await order.destroy({ force: true });
    throw new Error(errorMessage);
  }
}

async function processRecurringOrder(order: OrderModelInterface) {
  const hostStripeAccount = await order.collective.getHostStripeAccount();
  const host = await order.collective.getHostCollective();
  const isPlatformRevenueDirectlyCollected =
    host && APPLICATION_FEE_INCOMPATIBLE_CURRENCIES.includes(toUpper(host.currency))
      ? false
      : host?.settings?.isPlatformRevenueDirectlyCollected ?? true;
  const applicationFee = await getApplicationFee(order, { host });
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
  paymentIntentParams.customer = order.paymentMethod?.customerId;
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

    await order.update({
      data: { ...order.data, paymentIntent: { id: paymentIntent.id, status: paymentIntent.status } },
    });

    paymentIntent = await stripe.paymentIntents.confirm(paymentIntent.id, {
      stripeAccount: hostStripeAccount.username,
    });

    await order.update({ data: { ...order.data, paymentIntent } });

    if (paymentIntent.status === 'processing') {
      return;
    } else if (paymentIntent.status !== 'succeeded') {
      logger.error('Unknown error with Stripe Payment Intent.');
      reportMessageToSentry('Unknown error with Stripe Payment Intent', { extra: { paymentIntent } });
      throw new Error('Something went wrong with the payment, please contact support@opencollective.com.');
    }
  } catch (e) {
    const sanitizedError = pick(e, ['code', 'message', 'requestId', 'statusCode']);
    const errorMessage = `Error processing Stripe Payment Intent: ${e.message}`;
    logger.error(errorMessage, sanitizedError);
    // Hard-delete the order so we can re-use the existing Payment Intent in the next attempt.
    throw new Error(errorMessage);
  }
}

export default {
  features: {
    recurring: true,
    isRecurringManagedExternally: false,
    waitToCharge: false,
  },
  processOrder,
  refundTransaction,
  refundTransactionOnlyInDatabase,
} as PaymentProviderService;
