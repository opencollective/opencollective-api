/* eslint-disable camelcase */
import config from 'config';

import OrderStatuses from '../../constants/order_status';
import logger from '../../lib/logger';
import stripe from '../../lib/stripe';

export const createCheckoutSession = async order => {
  const hostStripeAccount = await order.collective.getHostStripeAccount();

  try {
    const session = await stripe.checkout.sessions.create(
      {
        success_url: `${config.host.website}/api/services/stripe/checkout?order=${order.id}`,
        cancel_url: `${config.host.website}/api/services/stripe/checkout?order=${order.id}`,
        line_items: [
          {
            price_data: {
              currency: order.currency,
              product_data: {
                name: order.collective.name,
                description: order.description,
              },
              unit_amount_decimal: order.totalAmount,
            },
            quantity: 1,
          },
        ],
        payment_method_types:
          order.currency === 'USD'
            ? ['us_bank_account']
            : order.currency === 'EUR'
            ? ['giropay', 'ideal', 'sepa_debit']
            : undefined,
        mode: 'payment',
        metadata: {
          from: `${config.host.website}/${order.fromCollective.slug}`,
          to: `${config.host.website}/${order.collective.slug}`,
        },
      },
      {
        stripeAccount: hostStripeAccount.username,
      },
    );
    await order.update({ data: { ...order.data, session } });
  } catch (e) {
    logger.error(e);
  }
};

export const confirmOrder = async order => {
  const hostStripeAccount = await order.collective.getHostStripeAccount();

  const session = await stripe.checkout.sessions.retrieve(order.data.session.id, {
    stripeAccount: hostStripeAccount.username,
  });

  if (session.status === 'complete') {
    await order.update({ data: { ...order.data, session }, status: OrderStatuses.PENDING });
    return order;
  } else {
    await order.destroy();
    return;
  }
};

export default {
  features: {
    recurring: false,
    waitToCharge: false,
  },
  processOrder: createCheckoutSession,
};
