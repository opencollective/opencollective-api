/* eslint-disable camelcase */

import debugLib from 'debug';
import { Request } from 'express';
import type Stripe from 'stripe';

import OrderStatuses from '../../constants/order_status';
import errors from '../../lib/errors';
import logger from '../../lib/logger';
import { sendEmailNotifications, sendOrderFailedEmail } from '../../lib/payments';
import stripe from '../../lib/stripe';
import models from '../../models';

import { createChargeTransactions } from './common';
import creditcard from './creditcard';
import * as virtualcard from './virtual-cards';

const debug = debugLib('stripe');

const paymentIntentSucceeded = async (event: Stripe.Response<Stripe.Event>) => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const order = await models.Order.findOne({
    where: {
      status: OrderStatuses.PROCESSING,
      data: { paymentIntent: { id: paymentIntent.id } },
    },
    include: [
      { association: 'collective', required: true },
      { association: 'fromCollective', required: true },
      { association: 'createdByUser', required: true },
    ],
  });

  if (!order) {
    logger.warn(`Stripe Webhook: Could not find Order for Payment Intent ${paymentIntent.id}`);
    return;
  }

  // Recently, Stripe updated their library and removed the 'charges' property in favor of 'latest_charge',
  // but this is something that only makes sense in the LatestApiVersion, and that's not the one we're using.
  const charge = (paymentIntent as any).charges.data[0] as Stripe.Charge;
  const transaction = await createChargeTransactions(charge, { order });

  await order.update({
    status: OrderStatuses.PAID,
    processedAt: new Date(),
    data: { ...order.data, paymentIntent },
  });

  if (order.fromCollective?.ParentCollectiveId !== order.collective.id) {
    await order.getOrCreateMembers();
  }

  sendEmailNotifications(order, transaction);
};

const paymentIntentProcessing = async (event: Stripe.Response<Stripe.Event>) => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const order = await models.Order.findOne({
    where: {
      status: [OrderStatuses.NEW, OrderStatuses.PROCESSING],
      data: { paymentIntent: { id: paymentIntent.id } },
    },
  });

  if (!order) {
    logger.warn(`Stripe Webhook: Could not find Order for Payment Intent ${paymentIntent.id}`);
    return;
  }

  await order.update({
    status: OrderStatuses.PROCESSING,
    data: { ...order.data, paymentIntent },
  });
};

const paymentIntentFailed = async (event: Stripe.Response<Stripe.Event>) => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const order = await models.Order.findOne({
    where: {
      status: OrderStatuses.PROCESSING,
      data: { paymentIntent: { id: paymentIntent.id } },
    },
    include: [
      { association: 'collective', required: true },
      { association: 'fromCollective', required: true },
      { association: 'createdByUser', required: true },
    ],
  });

  if (!order) {
    logger.warn(`Stripe Webhook: Could not find Order for Payment Intent ${paymentIntent.id}`);
    return;
  }
  const reason = paymentIntent.last_payment_error.message;
  logger.info(`Stripe Webook: Payment Intent failed for Order #${order.id}. Reason: ${reason}`);

  await order.update({
    status: OrderStatuses.ERROR,
    data: { ...order.data, paymentIntent },
  });

  sendOrderFailedEmail(order, reason);
};

export const webhook = async (request: Request<unknown, Stripe.Event>) => {
  const requestBody = request.body;

  debug(`Stripe webhook event received : ${request.rawBody}`);

  // Stripe sends test events to production as well
  // don't do anything if the event is not livemode
  // NOTE: not using config.env because of ugly tests
  if (process.env.OC_ENV === 'production' && !requestBody.livemode) {
    return Promise.resolve();
  }

  const stripeEvent = {
    signature: request.headers['stripe-signature'],
    rawBody: request.rawBody,
  };

  if (requestBody.type === 'issuing_authorization.request') {
    return virtualcard.processAuthorization(requestBody.data.object, stripeEvent);
  }

  if (requestBody.type === 'issuing_authorization.created' && !requestBody.data.object.approved) {
    return virtualcard.processDeclinedAuthorization(requestBody.data.object, stripeEvent);
  }

  if (requestBody.type === 'issuing_authorization.updated') {
    return virtualcard.processUpdatedTransaction(requestBody.data.object, stripeEvent);
  }

  if (requestBody.type === 'issuing_transaction.created') {
    return virtualcard.processTransaction(requestBody.data.object, stripeEvent);
  }

  if (requestBody.type === 'issuing_card.updated') {
    return virtualcard.processCardUpdate(requestBody.data.object, stripeEvent);
  }

  /**
   * We check the event on stripe directly to be sure we don't get a fake event from
   * someone else
   */
  // TODO: Change to https://stripe.com/docs/webhooks/signatures#verify-official-libraries
  //       to verify the signature without having to make another call to Stripe?
  return stripe.events
    .retrieve(requestBody.id, { stripeAccount: requestBody.user_id })
    .then((event: Stripe.Response<Stripe.Event>) => {
      if (!event || (event && !event.type)) {
        throw new errors.BadRequest('Event not found');
      }

      switch (event.type) {
        case 'charge.dispute.created':
          return creditcard.createDispute(event);
        // Charge dispute has been closed on Stripe (with status of: won/lost/closed)
        case 'charge.dispute.closed':
          return creditcard.closeDispute(event);
        case 'review.opened':
          return creditcard.openReview(event);
        case 'review.closed':
          return creditcard.closeReview(event);
        case 'payment_intent.succeeded':
          return paymentIntentSucceeded(event);
        case 'payment_intent.processing':
          return paymentIntentProcessing(event);
        case 'payment_intent.payment_failed':
          return paymentIntentFailed(event);
        default:
          // console.log(JSON.stringify(event, null, 4));
          logger.warn(`Stripe: Webhooks: Received an unsupported event type: ${event.type}`);
          return;
      }
    });
};
