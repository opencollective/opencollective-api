/* eslint-disable camelcase */

import { startsWith } from 'lodash';
import type Stripe from 'stripe';

import OrderStatuses from '../../constants/order_status';
import models, { Op } from '../../models';

import { createChargeTransactions } from './common';

export const handlePaymentIntent = async (event: Stripe.Response<Stripe.Event>) => {
  if (!startsWith(event.type, 'payment_intent')) {
    return;
  }

  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const charge = paymentIntent.charges.data[0];
  const order = await models.Order.findOne({
    where: {
      [Op.or]: [
        // Stripe Checkout
        {
          status: OrderStatuses.PENDING,
          data: { session: { payment_intent: paymentIntent.id } },
        },
        // TODO Add other async Payment Methods
      ],
    },
    include: [{ association: 'collective', required: true }],
  });

  if (!order) {
    return;
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      await createChargeTransactions(charge, { order });
      await order.update({ status: OrderStatuses.PAID, processedAt: new Date() });
      break;
    }
  }
};
