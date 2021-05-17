import Debug from 'debug';
import { Request } from 'express';
import { get, toNumber } from 'lodash';
import moment from 'moment';

import OrderStatus from '../../constants/order_status';
import logger from '../../lib/logger';
import { validateWebhookEvent } from '../../lib/paypal';
import { sendThankYouEmail } from '../../lib/recurring-contributions';
import models from '../../models';
import { PayoutWebhookRequest } from '../../types/paypal';

import { recordPaypalSale } from './payment';
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

/**
 * From a Webhook event + a subscription ID, returns the associated order along with the
 * host and PayPal account. Calls `validateWebhookEvent`, throwing if the webhook event is invalid
 */
const loadSubscriptionForWebhookEvent = async (req: Request, subscriptionId: string) => {
  const order = await models.Order.findOne({
    include: [
      { association: 'fromCollective' },
      { association: 'createdByUser' },
      { association: 'collective', required: true },
      {
        association: 'Subscription',
        required: true,
        where: { paypalSubscriptionId: subscriptionId },
      },
      {
        association: 'paymentMethod',
        required: true,
        where: { service: 'paypal', type: 'subscription' },
      },
    ],
  });

  if (!order) {
    throw new Error(`No order found for subscription ${subscriptionId}`);
  }

  const host = await order.collective.getHostCollective();
  const paypalAccount = await getPaypalAccount(host);
  await validateWebhookEvent(paypalAccount, req);
  return { host, order, paypalAccount };
};

async function handleSaleCompleted(req: Request): Promise<void> {
  // TODO During the internal testing phase, we're logging all webhooks events to make debugging easier
  logger.info(`PayPal webhook (PAYMENT.SALE.COMPLETED): ${JSON.stringify(req.body)}`);

  // 1. Retrieve the order for this subscription & validate webhook event
  const sale = req.body.resource;
  const subscriptionId = sale.billing_agreement_id;
  if (!subscriptionId) {
    // Direct charge (not recurring) - ignoring
    return;
  }

  const { order } = await loadSubscriptionForWebhookEvent(req, subscriptionId);

  // 2. Record the transaction
  const transaction = await recordPaypalSale(order, sale);

  // 3. Mark order/subscription as active
  if (order.status !== OrderStatus.ACTIVE) {
    await order.update({ status: OrderStatus.ACTIVE, processedAt: new Date() });
    await order.Subscription.update({
      chargeNumber: (order.Subscription.chargeNumber || 0) + 1,
      nextChargeDate: moment().add(1, order.interval),
      isActive: true,
    });
  }

  // 4. Send thankyou email
  await sendThankYouEmail(order, transaction);

  // 5. Register user as a member, since the transaction is not created in `processOrder`
  // for PayPal subscriptions.
  await order.getOrCreateMembers();
}

/**
 * Handles both `BILLING.SUBSCRIPTION.CANCELLED` (users cancelling their subscription through PayPal's UI)
 * and `BILLING.SUBSCRIPTION.SUSPENDED` (subscription "paused", for example when payment fail more than the maximum allowed)
 * in the the same way, by marking order as cancelled.
 */
async function handleSubscriptionCancelled(req: Request): Promise<void> {
  // TODO During the internal testing phase, we're logging all webhooks events to make debugging easier
  logger.info(`PayPal webhook (${get(req, 'body.event_type')}): ${JSON.stringify(req.body)}`);

  const subscription = req.body.resource;
  const { order } = await loadSubscriptionForWebhookEvent(req, subscription.id);
  if (order.status !== OrderStatus.CANCELLED) {
    await order.update({
      status: OrderStatus.CANCELLED,
      data: { ...order.data, paypalStatusChangeNote: subscription.status_change_note },
    });
    await order.Subscription.update({
      isActive: false,
      deactivatedAt: new Date(),
    });
  }
}

async function handleSubscriptionActivated(req: Request): Promise<void> {
  const subscription = req.body.resource;
  const email = subscription.subscriber?.email_address;
  if (email) {
    const { order } = await loadSubscriptionForWebhookEvent(req, subscription.id);
    await order.paymentMethod.update({ name: email });
  }
}

/**
 * Webhook entrypoint. When adding a new event type here, you should also add it to
 * `server/lib/paypal.ts` > `WATCHED_EVENT_TYPES` and run `scripts/update-hosts-paypal-webhooks.ts`
 * to update all existing webhooks.
 */
async function webhook(req: Request): Promise<void> {
  debug('new event', req.body);
  const eventType = get(req, 'body.event_type');
  switch (eventType) {
    case 'PAYMENT.PAYOUTS-ITEM':
      return handlePayoutTransactionUpdate(req);
    case 'PAYMENT.SALE.COMPLETED':
      return handleSaleCompleted(req);
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
      return handleSubscriptionCancelled(req);
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
      return handleSubscriptionActivated(req);
    default:
      logger.info(`Received unhandled PayPal event (${eventType}), ignoring it.`);
      break;
  }
}

export default webhook;
