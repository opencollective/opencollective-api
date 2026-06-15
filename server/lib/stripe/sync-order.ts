/* eslint-disable camelcase */
import { omit } from 'lodash';

import OrderStatuses from '../../constants/order-status';
import models from '../../models';
import { getPaymentIntentCharge } from '../../paymentProviders/stripe/common';
import { stripePaymentIntentFailed, stripePaymentIntentSucceeded } from '../../paymentProviders/stripe/webhook';
import stripe from '../stripe';
import type { Stripe } from '../stripe-types';

/** Builds the minimal `Stripe.Event` wrapper needed to re-run a payment intent webhook handler locally */
const buildPaymentIntentEvent = <T extends Stripe.PaymentIntentSucceededEvent | Stripe.PaymentIntentPaymentFailedEvent>(
  account: string,
  type: T['type'],
  paymentIntent: Stripe.PaymentIntent,
): T =>
  ({
    id: `evt_${paymentIntent.id}`,
    object: 'event',
    account,
    api_version: null,
    created: Math.floor(Date.now() / 1000),
    data: { object: paymentIntent },
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type,
  }) as unknown as T;

export const syncOrder = async (order, { IS_DRY, logging }: { IS_DRY?; logging? } = {}) => {
  logging?.(`Processing order ${order.id}...`);
  const storedStripePaymentIntent = order.data.stripePaymentIntent;
  if (!storedStripePaymentIntent?.id) {
    logging?.(`Order ${order.id} has no stripePaymentIntent`);
    return;
  }
  const hostStripeAccount = await order.collective.getHostStripeAccount();
  const stripeAccount = hostStripeAccount.username;
  const stripePaymentIntent = await stripe.paymentIntents.retrieve(storedStripePaymentIntent.id, undefined, {
    stripeAccount,
  });
  logging?.(`Order ${order.id} paymentIntent status: ${stripePaymentIntent.status}`);

  const charge = getPaymentIntentCharge(stripePaymentIntent);
  if (charge && stripePaymentIntent.status === 'succeeded') {
    logging?.(`Order ${order.id} has charge: ${charge.id}`);
    const transaction = await models.Transaction.findOne({
      where: { data: { charge: { id: charge.id } } },
    });
    if (transaction) {
      logging?.(`Order ${transaction.OrderId} already processed charge ${charge.id}`);
      if (transaction.OrderId !== order.id) {
        await order.update({
          status: OrderStatuses.CANCELLED,
          data: omit(order.data, ['stripePaymentIntent']),
        });
      }
      return;
    }

    logging?.(`Order ${order.id} is missing charge ${charge.id}, re-processing payment intent...`);
    if (!IS_DRY) {
      await stripePaymentIntentSucceeded(
        buildPaymentIntentEvent(stripeAccount, 'payment_intent.succeeded', stripePaymentIntent),
      );
    }
  } else if (charge?.status === 'failed') {
    logging?.(`Order ${order.id} has failed charge: ${charge.id}`);
    if (!IS_DRY) {
      await stripePaymentIntentFailed(
        buildPaymentIntentEvent(stripeAccount, 'payment_intent.payment_failed', stripePaymentIntent),
      );
    }
  } else if (!charge && ['requires_payment_method', 'requires_source'].includes(stripePaymentIntent.status)) {
    logging?.(`Order ${order.id} has no payment method`);
    if (!IS_DRY) {
      await order.update({
        status: OrderStatuses.ERROR,
        data: { ...order.data, stripePaymentIntent: stripePaymentIntent },
      });
    }
  }
};
