import config from 'config';
import { pick, toUpper } from 'lodash';
import type Stripe from 'stripe';

import OrderStatuses from '../../constants/order_status';
import logger from '../../lib/logger';
import { getApplicationFee } from '../../lib/payments';
import stripe, { convertToStripeAmount } from '../../lib/stripe';
import models from '../../models';

import { APPLICATION_FEE_INCOMPATIBLE_CURRENCIES, refundTransaction, refundTransactionOnlyInDatabase } from './common';

const processOrder = async (order: typeof models.Order): Promise<void> => {
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

export default {
  features: {
    recurring: false,
    waitToCharge: false,
  },
  processOrder,
  refundTransaction,
  refundTransactionOnlyInDatabase,
};
