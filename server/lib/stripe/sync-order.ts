import { omit } from 'lodash';
import Stripe from 'stripe';

import OrderStatuses from '../../constants/order-status';
import models from '../../models';
import { paymentIntentFailed } from '../../paymentProviders/stripe/webhook';
import stripe from '../stripe';

export const syncOrder = async (order, { IS_DRY, logging }: { IS_DRY?; logging? } = {}) => {
  logging?.(`Processing order ${order.id}...`);
  if (!order.data?.paymentIntent?.id) {
    logging?.(`Order ${order.id} has no paymentIntent`);
    return;
  }
  let hostStripeAccount;
  try {
    hostStripeAccount = await order.collective.getHostStripeAccount();
  } catch (err) {
    logging?.(`Host for ${order.id} has no stripe account`, err);
    if (!IS_DRY) {
      await order.update({
        status: OrderStatuses.CANCELLED,
      });
    }
    return;
  }
  const stripeAccount = hostStripeAccount.username;
  let paymentIntent: Stripe.Response<Stripe.PaymentIntent>;
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(order.data.paymentIntent.id, {
      stripeAccount,
    });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      // payment intent expired.
      if (err.code === 'resource_missing') {
        logging?.(`Order ${order.id} payment intent not found on stripe`, err);
        if (!IS_DRY) {
          await order.update({
            status: OrderStatuses.CANCELLED,
          });
        }
        return;
      }
    }

    logging?.(`Unknown error retrieving payment intent ${order.data.paymentIntent.id} on stripe`, err);
    return;
  }

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
          data: omit(order.data, 'paymentIntent'),
        });
      }
      return;
    }

    logging?.(`Order ${order.id} is missing charge ${charge.id}`);
  } else if (charge?.status === 'failed') {
    logging?.(`Order ${order.id} has failed charge: ${charge.id}`);
    if (!IS_DRY) {
      await paymentIntentFailed({ account: stripeAccount, data: { object: paymentIntent } } as any, {
        skipNotify: true,
      });
    }
  } else if (!charge && ['requires_payment_method', 'requires_source'].includes(paymentIntent.status)) {
    logging?.(`Order ${order.id} has no payment method`);
    if (!IS_DRY) {
      await order.update({
        status: OrderStatuses.ERROR,
        data: { ...order.data, paymentIntent },
      });
    }
  }
};
