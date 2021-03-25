import Debug from 'debug';
import { Request } from 'express';
import { get, toNumber } from 'lodash';
import moment from 'moment';

import logger from '../../lib/logger';
import { validateWebhookEvent } from '../../lib/paypal';
import models from '../../models';
import { PayoutWebhookRequest } from '../../types/paypal';

import { paypalRequest, recordPaypalSale, recordPaypalTransaction } from './payment';
import { checkBatchItemStatus } from './payouts';

const debug = Debug('paypal:webhook');

const getPaypalAccount = async host => {
  if (!host) {
    throw new Error('PayPal webhook: no host found');
  }

  const [connectedAccount] = await host.getConnectedAccounts({ where: { service: 'paypal', deletedAt: null } });
  if (!connectedAccount) {
    throw new Error(`Host ${host.slug} is not connected to PayPal`);
  }

  return connectedAccount;
};

async function handlePayoutTransactionUpdate(req: Request): Promise<void> {
  const event = req.body as PayoutWebhookRequest;
  const expense = await models.Expense.findOne({
    where: { id: toNumber(event.resource.payout_item.sender_item_id) },
    include: [{ model: models.Collective, as: 'collective' }],
  });

  if (!expense) {
    // This is probably some other transfer not executed through our platform.
    debug('event does not match any expense, ignoring');
    return;
  }

  const host = await expense.collective.getHostCollective();
  const paypalAccount = await getPaypalAccount(host);
  await validateWebhookEvent(paypalAccount, req);

  const item = event.resource;
  await checkBatchItemStatus(item, expense, host);
}

async function handleSaleCompleted(req: Request): Promise<void> {
  // TODO During the internal testing phase, we're logging all webhooks events to make debugging easier
  logger.info(`PayPal webhook (PAYMENT.SALE.COMPLETED): ${JSON.stringify(req.body)}`);

  // 1. Retrieve the order for this subscription
  const sale = req.body.resource;
  const subscriptionId = sale.billing_agreement_id;
  if (!subscriptionId) {
    // Direct charge (not recurring) - ignoring
    return;
  }

  const order = await models.Order.findOne({
    where: { data: { paypalSubscriptionId: subscriptionId } }, // TODO: Add index on paypalSubscriptionId
    include: [
      { association: 'collective', required: true },
      {
        association: 'paymentMethod',
        required: true,
        where: { service: 'paypal', type: 'payment' },
      },
    ],
  });

  if (!order) {
    throw new Error(`No order found for subscription ${subscriptionId}`);
  }

  // 2. Validate webhook event
  const host = await order.collective.getHostCollective();
  const paypalAccount = await getPaypalAccount(host);
  await validateWebhookEvent(paypalAccount, req);

  // 3. Record the transaction
  await recordPaypalSale(order, sale);
}

async function handleBillingSubscriptionActivated(req: Request): Promise<void> {
  // TODO During the internal testing phase, we're logging all webhooks events to make debugging easier
  logger.info(`PayPal webhook (BILLING.SUBSCRIPTION.ACTIVATED): ${JSON.stringify(req.body)}`);

  // 1. Retrieve the order for this subscription
  const subscription = req.body.resource;
  const subscriptionId = subscription.id;
  const order = await models.Order.findOne({
    where: { data: { paypalSubscriptionId: subscriptionId } }, // TODO: Add index on paypalSubscriptionId
    include: [
      { association: 'collective', required: true },
      {
        association: 'paymentMethod',
        required: true,
        where: { service: 'paypal', type: 'payment' },
      },
    ],
  });

  if (!order) {
    throw new Error(`No order found for subscription ${subscriptionId}`);
  }

  // 2. Validate webhook event
  const host = await order.collective.getHostCollective();
  const paypalAccount = await getPaypalAccount(host);
  await validateWebhookEvent(paypalAccount, req);

  // 3. List transactions & record the first one
  const lastPaymentTime = moment(subscription.billing_info.last_payment.time);
  const startTime = lastPaymentTime.subtract(1, 'day').toISOString();
  const endTime = lastPaymentTime.add(1, 'day').toISOString();
  const requestUrl = `billing/subscriptions/${subscriptionId}/transactions?start_time=${startTime}&end_time=${endTime}`;
  const result = await paypalRequest(requestUrl, null, host, 'GET');
  return recordPaypalTransaction(order, result.transactions[0]);
}

async function webhook(req: Request): Promise<void> {
  debug('new event', req.body);
  const eventType = get(req, 'body.event_type');
  switch (eventType) {
    case 'PAYMENT.PAYOUTS-ITEM':
      return handlePayoutTransactionUpdate(req);
    case 'PAYMENT.SALE.COMPLETED':
      return handleSaleCompleted(req);
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
      return handleBillingSubscriptionActivated(req);
    default:
      logger.info(`Received unhandled PayPal event (${eventType}), ignoring it.`);
      break;
  }
}

export default webhook;
