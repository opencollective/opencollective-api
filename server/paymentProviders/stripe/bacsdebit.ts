import config from 'config';
import { pick, toUpper } from 'lodash';
import type Stripe from 'stripe';

import OrderStatuses from '../../constants/order-status';
import logger from '../../lib/logger';
import { getApplicationFee } from '../../lib/payments';
import { reportMessageToSentry } from '../../lib/sentry';
import stripe, { convertToStripeAmount } from '../../lib/stripe';
import Order from '../../models/Order';
import { PaymentProviderServiceWithInternalRecurringManagement } from '../types';

import { APPLICATION_FEE_INCOMPATIBLE_CURRENCIES, refundTransaction, refundTransactionOnlyInDatabase } from './common';

const processOrder = async (order: Order): Promise<void> => {
  if (order.paymentMethod?.data?.stripeMandate?.status === 'inactive') {
    throw new Error('The mandate to charge using this payment method is inactive.');
  }

  const hostStripeAccount = await order.collective.getHostStripeAccount();
  const host = await order.collective.getHostCollective();
  const isPlatformRevenueDirectlyCollected =
    host && APPLICATION_FEE_INCOMPATIBLE_CURRENCIES.includes(toUpper(host.currency))
      ? false
      : (host?.settings?.isPlatformRevenueDirectlyCollected ?? true);
  const applicationFee = await getApplicationFee(order);

  const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
    customer: order.paymentMethod.customerId,
    currency: order.currency,
    amount: convertToStripeAmount(order.currency, order.totalAmount),
    description: order.description,
    metadata: {
      from: `${config.host.website}/${order.fromCollective.slug}`,
      to: `${config.host.website}/${order.collective.slug}`,
      orderId: order.id,
    },
    // eslint-disable-next-line camelcase
    payment_method: order.paymentMethod.data?.stripePaymentMethodId,
    // eslint-disable-next-line camelcase
    payment_method_types: ['bacs_debit'],
  };

  if (applicationFee && isPlatformRevenueDirectlyCollected && hostStripeAccount.username !== config.stripe.accountId) {
    // eslint-disable-next-line camelcase
    paymentIntentParams.application_fee_amount = convertToStripeAmount(order.currency, applicationFee);
  }

  try {
    let stripePaymentIntent = await stripe.paymentIntents.create(paymentIntentParams, {
      stripeAccount: hostStripeAccount.username,
    });

    const paymentIntentSnapshot = { id: stripePaymentIntent.id, status: stripePaymentIntent.status };
    await order.update({
      data: { ...order.data, stripePaymentIntent: paymentIntentSnapshot },
    });

    stripePaymentIntent = await stripe.paymentIntents.confirm(
      stripePaymentIntent.id,
      {
        mandate: order.paymentMethod?.data?.stripeMandate?.id,
      },
      {
        stripeAccount: hostStripeAccount.username,
      },
    );

    await order.update({
      status: OrderStatuses.PROCESSING,
      data: { ...order.data, stripePaymentIntent },
    });

    if (stripePaymentIntent.status === 'processing') {
      return;
    } else if (stripePaymentIntent.status !== 'succeeded') {
      logger.error('Unknown error with Stripe Payment Intent.');
      reportMessageToSentry('Unknown error with Stripe Payment Intent', {
        extra: { stripePaymentIntent },
      });
      throw new Error('Something went wrong with the payment, please contact support@opencollective.com.');
    }
  } catch (e) {
    const sanitizedError = pick(e, ['code', 'message', 'requestId', 'statusCode']);
    const errorMessage = `Error processing Stripe bacs_debit: ${e.message}`;
    logger.error(errorMessage, sanitizedError);
    throw new Error(errorMessage);
  }
};

export default {
  features: {
    recurring: true,
    isRecurringManagedExternally: false,
    waitToCharge: false,
  },
  processOrder,
  refundTransaction,
  refundTransactionOnlyInDatabase,
} as PaymentProviderServiceWithInternalRecurringManagement;
