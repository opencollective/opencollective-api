#!/usr/bin/env ./node_modules/.bin/babel-node
import '../server/env';

import { get, last, omit } from 'lodash';

import OrderStatuses from '../server/constants/order_status';
import logger from '../server/lib/logger';
import { createSubscription, sendEmailNotifications } from '../server/lib/payments';
import stripe from '../server/lib/stripe';
import models from '../server/models';
import { createChargeTransactions } from '../server/paymentProviders/stripe/common';
import { createOrUpdateOrderStripePaymentMethod } from '../server/paymentProviders/stripe/webhook';

if (process.argv.length < 3) {
  console.error('Usage: ./scripts/diff-stripe-transactions.js HOST_SLUG [NB_CHARGES_TO_CHECK=100] [LAST_CHARGE_ID]');
  process.exit(1);
}

const HOST_SLUG = process.argv[2];
const NB_CHARGES_TO_CHECK = parseInt(process.argv[3]) || 100;
const LAST_CHARGE_ID = process.argv[4] || undefined;
const NB_CHARGES_PER_QUERY = 100; // Max allowed by Stripe
const NB_PAGES = NB_CHARGES_TO_CHECK / NB_CHARGES_PER_QUERY;

/*
async function checkCharge(charge) {
  if (charge.failure_code) {
    // Ignore failed transaction
    console.log(`Ignoring ${charge.id} (failed transaction)`);
    return;
  }

  const slug = charge.metadata.to.replace('https://opencollective.com/', '');
  const collective = await models.Collective.findOne({
    where: { slug: slug },
  });
  if (!collective) {
    console.log(`Ignoring ${charge.id} (could not find Collective ${slug})`);
    return;
  }

  const transaction = await models.Transaction.findOne({
    where: { CollectiveId: collective.id, data: { charge: { id: charge.id } } },
    order: [['id', 'DESC']],
  });

  if (!transaction) {
    console.error(`🚨️ Missing transaction for stripe charge ${charge.id}`);
  }
}
*/

const getHostStripeAccountUsername = async slug => {
  const hostId = (await models.Collective.findOne({ where: { slug } }))?.id;
  if (!hostId) {
    throw new Error('Host not found');
  }

  const stripeAccount = await models.ConnectedAccount.findOne({ where: { service: 'stripe', CollectiveId: hostId } });
  if (!stripeAccount) {
    throw new Error('No stripe account found for this host');
  }

  return stripeAccount.username;
};

async function recordCharge(charge, paymentIntent, stripeAccount) {
  // Copy code from Stripe webhook (paymentIntentSucceeded)
  const order = await models.Order.findOne({
    where: {
      data: { paymentIntent: { id: paymentIntent.id } },
    },
    include: [
      { association: 'collective', required: true },
      { association: 'fromCollective', required: true },
      { association: 'createdByUser', required: true },
    ],
  });

  if (!order) {
    logger.debug(`Stripe Webhook: Could not find Order for Payment Intent ${paymentIntent.id}`);
    return;
  }

  // If charge was already processed, ignore event. (Potential edge-case: if the webhook is called while processing a 3DS validation)
  const existingChargeTransaction = await models.Transaction.findOne({
    where: { OrderId: order.id, data: { charge: { id: charge.id } } },
  });
  if (existingChargeTransaction) {
    logger.info(`Stripe Webhook: ${order.id} already processed charge ${charge.id}, ignoring event ${event.id}`);
    return;
  }

  await createOrUpdateOrderStripePaymentMethod(order, stripeAccount, paymentIntent);

  const transaction = await createChargeTransactions(charge, { order });

  // after successful first payment of a recurring subscription where the payment confirmation is async
  // and the subscription is managed by us.
  if (order.interval && !order.SubscriptionId) {
    await createSubscription(order);
  }

  await order.update({
    status: !order.SubscriptionId ? OrderStatuses.PAID : OrderStatuses.ACTIVE,
    processedAt: new Date(),
    data: {
      ...omit(order.data, 'paymentIntent'),
      previousPaymentIntents: [...(order.data.previousPaymentIntents ?? []), paymentIntent],
    },
  });

  if (order.fromCollective?.ParentCollectiveId !== order.collective.id) {
    await order.getOrCreateMembers();
  }

  sendEmailNotifications(order, transaction);
}

async function main() {
  const stripeUserName = await getHostStripeAccountUsername(HOST_SLUG);
  let lastChargeId = LAST_CHARGE_ID;
  let totalAlreadyChecked = 0;

  console.info(`Starting the diff of Stripe VS Transactions for the latest ${NB_CHARGES_TO_CHECK} paymentIntents`);
  for (let pageNum = 0; pageNum < NB_PAGES; pageNum++) {
    // Log the current page
    const nbToCheckInThisPage = Math.min(NB_CHARGES_PER_QUERY, NB_CHARGES_TO_CHECK - totalAlreadyChecked);
    console.info(`🔎️ Checking paymentIntents ${totalAlreadyChecked} to ${totalAlreadyChecked + nbToCheckInThisPage}`);

    // Retrieve the list and check all charges
    const paymentIntents = await stripe.paymentIntents.list(
      { limit: nbToCheckInThisPage, starting_after: lastChargeId }, // eslint-disable-line camelcase
      { stripeAccount: stripeUserName },
    );
    for (let idx = 0; idx < paymentIntents.data.length; idx++) {
      const paymentIntent = paymentIntents.data[idx];
      if (paymentIntent.status === 'succeeded') {
        const charge = paymentIntent.charges.data[0];
        if (charge.payment_method_details.type === 'link') {
          // await checkCharge(charge);
          await recordCharge(charge, paymentIntent, stripeUserName);
        } else {
          // Non-link Payment Method type
        }
      } else {
        // Payment Intent not succeeded
      }

      totalAlreadyChecked += 1;
      if (idx >= nbToCheckInThisPage) {
        break;
      }
    }

    // We reached the end
    if (!paymentIntents.has_more) {
      break;
    }

    // Register last charge for pagination
    lastChargeId = get(last(paymentIntents.data), 'id');
  }

  console.info('--------------------------------------\nDone!');
}

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
