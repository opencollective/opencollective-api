#!/usr/bin/env ./node_modules/.bin/babel-node
import '../../server/env.js';

import { compact, toNumber } from 'lodash-es';
import type Stripe from 'stripe';

import stripe from '../../server/lib/stripe.js';
import models from '../../server/models/index.js';
import { paymentIntentFailed, paymentIntentSucceeded } from '../../server/paymentProviders/stripe/webhook.js';

const IS_DRY = !!process.env.DRY;

const processOrder = async order => {
  console.log(`Processing order ${order.id}...`);
  if (!order.data?.paymentIntent?.id) {
    console.log(`Order ${order.id} has no paymentIntent`);
    return;
  }
  const hostStripeAccount = await order.collective.getHostStripeAccount();
  const stripeAccount = hostStripeAccount.username;
  const paymentIntent = await stripe.paymentIntents.retrieve(order.data.paymentIntent.id, {
    stripeAccount,
  });
  console.log(`Order ${order.id} paymentIntent status: ${paymentIntent.status}`);

  const charge = (paymentIntent as any).charges?.data?.[0] as Stripe.Charge;
  if (charge && paymentIntent.status === 'succeeded') {
    console.log(`Order ${order.id} has charge: ${charge.id}`);
    const transaction = await models.Transaction.findOne({
      where: { OrderId: order.id, data: { charge: { id: charge.id } } },
    });
    if (transaction) {
      console.log(`Order ${order.id} already processed charge ${charge.id}`);
      return;
    }

    console.log(`Order ${order.id} is missing charge ${charge.id}, re-processing payment intent...`);
    if (!IS_DRY) {
      await paymentIntentSucceeded({ account: stripeAccount, data: { object: paymentIntent } } as any);
    }
  } else if (charge?.status === 'failed') {
    console.log(`Order ${order.id} has failed charge: ${charge.id}`);
    if (!IS_DRY) {
      await paymentIntentFailed({ account: stripeAccount, data: { object: paymentIntent } } as any);
    }
  }
};

const main = async () => {
  const transactionIds = compact(process.argv.slice(2).map(toNumber));
  for (const id of transactionIds) {
    const order = await models.Order.findByPk(id, {
      include: [{ model: models.Collective, as: 'collective' }],
    });
    await processOrder(order);
  }
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
