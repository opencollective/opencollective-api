import { omit } from 'lodash';
import type Stripe from 'stripe';

import OrderStatuses from '../../constants/order-status';
import models from '../../models';
import { stripePaymentIntentFailed, stripePaymentIntentSucceeded } from '../../paymentProviders/stripe/webhook';
import stripe from '../stripe';

export const syncOrder = async (order, { IS_DRY, logging }: { IS_DRY?; logging? } = {}) => {
  logging?.(`Processing order ${order.id}...`);
  const storedStripePaymentIntent = order.data.stripePaymentIntent;
  if (!storedStripePaymentIntent?.id) {
    logging?.(`Order ${order.id} has no stripePaymentIntent`);
    return;
  }
  const hostStripeAccount = await order.collective.getHostStripeAccount();
  const stripeAccount = hostStripeAccount.username;
  const stripePaymentIntent = await stripe.paymentIntents.retrieve(storedStripePaymentIntent.id, {
    stripeAccount,
  });
  logging?.(`Order ${order.id} paymentIntent status: ${stripePaymentIntent.status}`);

  const charge = (stripePaymentIntent as any).charges?.data?.[0] as Stripe.Charge;
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
      await stripePaymentIntentSucceeded({ account: stripeAccount, data: { object: stripePaymentIntent } } as any);
    }
  } else if (charge?.status === 'failed') {
    logging?.(`Order ${order.id} has failed charge: ${charge.id}`);
    if (!IS_DRY) {
      await stripePaymentIntentFailed({ account: stripeAccount, data: { object: stripePaymentIntent } } as any);
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
