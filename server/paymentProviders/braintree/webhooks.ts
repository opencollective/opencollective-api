import OrderStatus from '../../constants/order_status';
import logger from '../../lib/logger';
import { sendThankYouEmail } from '../../lib/recurring-contributions';
import models from '../../models';

import { getBraintreeGatewayForHost } from './gateway';
import { BraintreeTransactionAlreadyExistsError, createTransactionsPairFromBraintreeTransaction } from './helpers';

const onSubscriptionChargedSuccessfully = async (braintreeNotification): Promise<void> => {
  // Ignore the first event, as it's recorded directly in `processOrder`
  if (braintreeNotification.subscription.currentBillingCycle === 1) {
    logger.debug('Braintree notification is for the first charge, ignoring');
    return;
  }

  // Only take the latest transaction (the one concerned by this notification)
  const braintreeTransaction = braintreeNotification.subscription.transactions[0];

  // Retrieve the order and do some sanity checks to make sure the subscription is healthy
  const order = await models.Order.findOne({
    include: [
      { association: 'paymentMethod', required: true },
      { association: 'collective' },
      { association: 'fromCollective' },
      { association: 'createdByUser' },
    ],
    where: {
      data: {
        braintree: {
          subscriptionId: braintreeNotification.subscription.id, // TODO(Braintree): Create an index for this
        },
      },
    },
  });

  if (!order) {
    throw new Error(`No order found for subscription: ${braintreeNotification.subscription.id}`);
  } else if (!order.collective) {
    throw new Error(
      `Received a subscription payment (order #${order.id}) for a deleted collective. Please unsubscribe immediately and refund the transaction!`,
    );
  } else if (!order.collective.isActive) {
    throw new Error(
      `Received a subscription payment (order #${order.id}) for an inactive collective. Please unsubscribe immediately and refund the transaction!`,
    );
  }

  try {
    // Record the transaction
    const transaction = await createTransactionsPairFromBraintreeTransaction(order, braintreeTransaction);

    // Update the order
    if (order.status !== OrderStatus.ACTIVE) {
      await order.update({ status: 'ACTIVE' });
    }

    // Send thank you email
    await sendThankYouEmail(order, transaction);
  } catch (error) {
    if (error instanceof BraintreeTransactionAlreadyExistsError) {
      // This will not corrupt the data if we end up here, but it should not happen since we check `currentBillingCycle`
      logger.warn(`Tried to register an existing braintree transaction: ${error.braintreeTransaction.id}`);
      return;
    } else {
      throw error;
    }
  }
};

export const braintreeWebhookCallback = async (
  hostId: number,
  btSignature: string,
  btPayload: string,
): Promise<void> => {
  const gateway = await getBraintreeGatewayForHost(hostId);
  const braintreeNotification = await gateway.webhookNotification.parse(btSignature, btPayload);
  logger.debug(`Received Braintree notification: ${braintreeNotification.kind}`);
  switch (braintreeNotification.kind) {
    case 'subscription_charged_successfully':
      return onSubscriptionChargedSuccessfully(braintreeNotification);
    default:
      logger.debug(`Braintree notification ${braintreeNotification.kind} not supported, ignoring`);
      return;
  }
};
