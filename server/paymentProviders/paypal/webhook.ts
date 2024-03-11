import Debug from 'debug';
import { Request } from 'express';
import { get, toNumber } from 'lodash';
import moment from 'moment';

import FEATURE from '../../constants/feature';
import OrderStatus from '../../constants/order-status';
import { PAYMENT_METHOD_SERVICE } from '../../constants/paymentMethods';
import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import logger from '../../lib/logger';
import { floatAmountToCents } from '../../lib/math';
import { createRefundTransaction } from '../../lib/payments';
import { validateWebhookEvent } from '../../lib/paypal';
import { sendThankYouEmail } from '../../lib/recurring-contributions';
import { reportErrorToSentry, reportMessageToSentry } from '../../lib/sentry';
import models, { Op } from '../../models';
import { PayoutWebhookRequest, PaypalCapture } from '../../types/paypal';

import { paypalRequestV2 } from './api';
import { findTransactionByPaypalId, recordPaypalCapture, recordPaypalSale } from './payment';
import { checkBatchItemStatus } from './payouts';
import { CANCEL_PAYPAL_EDITED_SUBSCRIPTION_REASON } from './subscription';

const debug = Debug('paypal:webhook');

const getPaypalAccount = async host => {
  if (!host) {
    throw new Error('PayPal webhook: no host found');
  }

  return host.getAccountForPaymentProvider('paypal');
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
  if (!host) {
    throw new Error(`No host found for collective ${expense.collective.slug}`);
  }

  const paypalAccount = await getPaypalAccount(host);
  await validateWebhookEvent(paypalAccount, req);

  const item = event.resource;
  await checkBatchItemStatus(item, expense, host);
}

/**
 * From a Webhook event + a subscription ID, returns the associated order along with the
 * host and PayPal account. Calls `validateWebhookEvent`, throwing if the webhook event is invalid
 */
const loadSubscriptionForWebhookEvent = async (
  req: Request,
  subscriptionId: string,
  { throwIfMissing = true } = {},
) => {
  // TODO: This can be optimized by using the `host` from path

  const order = await models.Order.findOne({
    include: [
      { association: 'fromCollective', required: false },
      { association: 'createdByUser', required: false },
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
    if (throwIfMissing) {
      throw new Error(`No order found for subscription ${subscriptionId}`);
    } else {
      return null;
    }
  } else if (order.isLocked()) {
    throw new Error('This order is already been processed, please try again later');
  }

  const host = await order.collective.getHostCollective();
  if (!host) {
    throw new Error(`No host found for collective ${order.collective.slug}`);
  }

  const paypalAccount = await getPaypalAccount(host);
  await validateWebhookEvent(paypalAccount, req);
  return { host, order, paypalAccount };
};

async function handleSaleCompleted(req: Request): Promise<void> {
  // 1. Retrieve the order for this subscription & validate webhook event
  const sale = req.body.resource;
  const subscriptionId = sale.billing_agreement_id;
  if (!subscriptionId) {
    // Direct charge (not recurring) - ignoring
    return;
  }

  // 2. Lock & process the order
  let transaction;
  const { order } = await loadSubscriptionForWebhookEvent(req, subscriptionId);
  await order.lock(async () => {
    // 2.1 Make sure the sale hasn't already been recorded
    const existingTransaction = await findTransactionByPaypalId(sale.id, { OrderId: order.id });
    if (existingTransaction) {
      logger.debug(`PayPal: Transaction for sale ${sale.id} already recorded, ignoring`);
      return;
    }

    // 2.2 Record the transaction
    transaction = await recordPaypalSale(order, sale);

    // 2.3 Mark order/subscription as active
    if (order.status !== OrderStatus.ACTIVE) {
      await order.update({ status: OrderStatus.ACTIVE, processedAt: new Date() });
    }

    const nextChargeDate = moment().add(1, order.interval as any);
    await order.Subscription.update({
      chargeNumber: (order.Subscription.chargeNumber || 0) + 1,
      nextChargeDate: nextChargeDate,
      nextPeriodStart: nextChargeDate,
      isActive: true,
      activatedAt: order.Subscription.activatedAt || new Date(),
    });
  });

  // 3. Send thankyou email
  const isFirstPayment = order.Subscription.chargeNumber === 1;
  await sendThankYouEmail(order, transaction, isFirstPayment);

  // 4. Register user as a member, since the transaction is not created in `processOrder`
  // for PayPal subscriptions.
  await order.getOrCreateMembers();
}

async function handleCaptureCompleted(req: Request): Promise<void> {
  // TODO: This can be optimized by using the `host` from path
  // Retrieve the order for this event
  const capture = req.body.resource;
  const order = await models.Order.findOne({
    where: {
      status: OrderStatus.NEW,
      data: { paypalCaptureId: capture.id },
    },
    include: [
      { association: 'fromCollective' },
      { association: 'createdByUser' },
      { association: 'collective', required: true },
      {
        association: 'paymentMethod',
        required: true,
        where: { service: 'paypal', type: 'payment' },
      },
    ],
  });

  if (!order) {
    logger.debug(`No pending order found for capture ${capture.id}`);
    return;
  } else if (order.isLocked()) {
    throw new Error('This order is already been processed, please try again later');
  }

  // Validate webhook event
  const host = await order.collective.getHostCollective();
  if (!host) {
    throw new Error(`No host found for collective ${order.collective.slug}`);
  }

  const paypalAccount = await getPaypalAccount(host);
  await validateWebhookEvent(paypalAccount, req);

  let transaction;
  await order.lock(async () => {
    // Make sure the transaction is not already recorded
    const existingTransaction = await models.Transaction.findOne({
      where: {
        OrderId: order.id,
        data: { capture: { id: capture.id } },
      },
    });

    if (existingTransaction) {
      logger.debug(`Transaction for PayPal capture ${capture.id} already exists`);
      return;
    }

    // Record the transaction
    transaction = await recordPaypalCapture(order, capture);
    await order.update({ processedAt: new Date(), status: OrderStatus.PAID });
  });

  // Send thankyou email
  await sendThankYouEmail(order, transaction);

  // Register user as a member, since the transaction is not created in `processOrder`
  await order.getOrCreateMembers();
}

async function handleCaptureRefunded(req: Request): Promise<void> {
  if (!req.params.hostId) {
    // Received on legacy webhook
    logger.warn('Please update PayPal webhooks to latest version using scripts/paypal/update-hosts-webhooks.ts');
  }

  // Validate webhook event
  const host = await models.Collective.findByPk(req.params.hostId);
  if (!host) {
    throw new Error(`No host found for ID ${req.params.hostId}`);
  }

  const paypalAccount = await getPaypalAccount(host);
  await validateWebhookEvent(paypalAccount, req);

  // Retrieve the data for this event
  const refund = req.body.resource;
  const refundDetails = await paypalRequestV2(`payments/refunds/${refund.id}`, host, 'GET');
  const refundLinks = <Record<string, string>[]>refundDetails.links;
  const captureLink = refundLinks.find(l => l.rel === 'up' && l.method === 'GET');
  const capturePath = captureLink.href.replace(/^.+\/v2\//, ''); // https://api.sandbox.paypal.com/v2/payments/captures/... -> payments/captures/...
  const captureDetails = (await paypalRequestV2(capturePath, host, 'GET')) as PaypalCapture;

  // Load associated transaction, make sure they're not refunded already
  const transaction = await models.Transaction.findOne({
    where: {
      type: TransactionTypes.CREDIT,
      kind: TransactionKind.CONTRIBUTION,
      isRefund: false,
      RefundTransactionId: null,
      data: {
        [Op.or]: [
          { capture: { id: captureDetails.id } },
          { paypalSale: { id: captureDetails.id } },
          { paypalTransaction: { id: captureDetails.id } },
        ],
      },
    },
    include: [
      {
        model: models.PaymentMethod,
        required: true,
        where: { service: PAYMENT_METHOD_SERVICE.PAYPAL },
      },
      {
        model: models.Order,
        required: true,
        include: [{ association: 'collective', required: true }],
      },
    ],
  });

  if (!transaction) {
    logger.debug(`PayPal: Refund - No transaction found for capture ${captureDetails.id}`);
    return;
  } else if (transaction.data.isRefundedFromOurSystem) {
    // Ignore
    return;
  } else if (transaction.Order.isLocked()) {
    throw new Error('This order is already been processed, please try again later');
  }

  await transaction.Order.lock(async () => {
    // Reload the transaction to make sure it hasn't been refunded already in the meantime
    const reloadedTransaction = await models.Transaction.findByPk(transaction.id);
    if (reloadedTransaction.data.isRefundedFromOurSystem || reloadedTransaction.RefundTransactionId) {
      return;
    }

    // Record the refund transactions
    const rawRefundedPaypalFee = <string>get(refundDetails, 'seller_payable_breakdown.paypal_fee.value', '0.00');
    const refundedPaypalFee = floatAmountToCents(parseFloat(rawRefundedPaypalFee));
    const dataPayload = { paypalResponse: refundDetails, isRefundedFromPayPal: true };
    await createRefundTransaction(transaction, refundedPaypalFee, dataPayload, null);
  });
}

/**
 * Handles both `BILLING.SUBSCRIPTION.CANCELLED` (users cancelling their subscription through PayPal's UI)
 * and `BILLING.SUBSCRIPTION.SUSPENDED` (subscription "paused", for example when payment fail more than the maximum allowed)
 * in the the same way, by marking order as cancelled.
 */
async function handleSubscriptionCancelled(req: Request): Promise<void> {
  const subscription = req.body.resource;
  if (subscription['status_change_note'] === CANCEL_PAYPAL_EDITED_SUBSCRIPTION_REASON) {
    // Ignore, this is a subscription that was updated by the user through the edit subscription page
    return;
  }

  const result = await loadSubscriptionForWebhookEvent(req, subscription.id, { throwIfMissing: false });
  if (!result) {
    // It's fine to ignore this event: if we can't find the subscription, it's probably because it was
    // already updated with a new plan or payment method. We still log it for debugging purposes.
    reportMessageToSentry(`No order found while cancelling PayPal subscription`, {
      feature: FEATURE.PAYPAL_DONATIONS,
      severity: 'warning',
      extra: { body: req.body },
    });
    return;
  }

  const { order } = result;
  if (order.status !== OrderStatus.CANCELLED) {
    await order.update({
      status: OrderStatus.CANCELLED,
      data: { ...order.data, paypalStatusChangeNote: subscription.status_change_note },
    });
    await order.Subscription.update({
      isActive: false,
      deactivatedAt: new Date(),
      nextChargeDate: null,
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
  try {
    const eventType = get(req, 'body.event_type');
    switch (eventType) {
      case 'PAYMENT.PAYOUTS-ITEM':
        return handlePayoutTransactionUpdate(req);
      case 'PAYMENT.SALE.COMPLETED':
        return handleSaleCompleted(req);
      case 'PAYMENT.CAPTURE.COMPLETED':
        return handleCaptureCompleted(req);
      case 'PAYMENT.CAPTURE.REFUNDED':
      case 'PAYMENT.CAPTURE.REVERSED':
        return handleCaptureRefunded(req);
      case 'BILLING.SUBSCRIPTION.CANCELLED':
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
        return handleSubscriptionCancelled(req);
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
        return handleSubscriptionActivated(req);
      default:
        logger.info(`Received unhandled PayPal event (${eventType}), ignoring it.`);
        break;
    }
  } catch (e) {
    reportErrorToSentry(e, {
      req,
      feature: FEATURE.PAYPAL_DONATIONS,
      extra: { body: req.body },
      severity: 'error',
      tags: { paypalWebhook: 'true' },
    });

    throw e;
  }
}

export default webhook;
