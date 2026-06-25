import { omit } from 'lodash';
import type Stripe from 'stripe';

import OrderStatuses from '../../constants/order-status';
import models from '../../models';
import { stripePaymentIntentFailed, stripePaymentIntentSucceeded } from '../../paymentProviders/stripe/webhook';
import stripe from '../stripe';

export const syncOrder = async (order, { IS_DRY, logging }: { IS_DRY?; logging? } = {}) => {
  logging?.(`Processing order ${order.id}...`);
  // TODO(#8851): remove `paymentIntent`
  const stripePaymentIntent = order.data.stripePaymentIntent ?? order.data.paymentIntent;
  if (!stripePaymentIntent?.id) {
    logging?.(`Order ${order.id} has no stripePaymentIntent`);
    return;
  }
  const hostStripeAccount = await order.collective.getHostStripeAccount();
  const stripeAccount = hostStripeAccount.username;
  const paymentIntent = await stripe.paymentIntents.retrieve(stripePaymentIntent.id, {
    stripeAccount,
  });
  logging?.(`Order ${order.id} paymentIntent status: ${paymentIntent.status}`);

  const charge = (paymentIntent as any).charges?.data?.[0] as Stripe.Charge;
  if (charge && paymentIntent.status === 'succeeded') {
    logging?.(`Order ${order.id} has charge: ${charge.id}`);
    const transaction = await models.Transaction.findOne({
      where: { data: { charge: { id: charge.id } } },
    });
    if (transaction) {
      logging?.(`Order ${transaction.OrderId} already processed charge ${charge.id}`);
      if (transaction.OrderId !== order.id) {
        await order.update({
          status: OrderStatuses.CANCELLED,
          data: omit(order.data, ['stripePaymentIntent', 'paymentIntent']), // TODO(#8851): remove `paymentIntent`
        });
      }
      return;
    }

    logging?.(`Order ${order.id} is missing charge ${charge.id}, re-processing payment intent...`);
    if (!IS_DRY) {
      await stripePaymentIntentSucceeded({ account: stripeAccount, data: { object: paymentIntent } } as any);
    }
  } else if (charge?.status === 'failed') {
    logging?.(`Order ${order.id} has failed charge: ${charge.id}`);
    if (!IS_DRY) {
      await stripePaymentIntentFailed({ account: stripeAccount, data: { object: paymentIntent } } as any);
    }
  } else if (!charge && ['requires_payment_method', 'requires_source'].includes(paymentIntent.status)) {
    logging?.(`Order ${order.id} has no payment method`);
    if (!IS_DRY) {
      await order.update({
        status: OrderStatuses.ERROR,
        data: { ...order.data, stripePaymentIntent: paymentIntent, paymentIntent }, // TODO(#8851): remove `paymentIntent`
      });
    }
  }
};
