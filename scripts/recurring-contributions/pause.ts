/**
 * A script to cancel all subscriptions for a given collective.
 *
 * Before https://github.com/opencollective/opencollective-api/pull/8004, unhosted collectives
 * would not get their PayPal contributions cancelled. This script:
 * - Finds all active PayPal subscriptions for a given collective
 * - Cancels them
 * - Refunds the payments made since the unhosting date
 */

import '../../server/env';

const DRY_RUN = process.env.DRY_RUN !== 'false';

import { Command } from 'commander';

import OrderStatuses from '../../server/constants/order-status';
import logger from '../../server/lib/logger';
import { pauseOrder } from '../../server/lib/payments';
import models, { Order } from '../../server/models';

const main = async () => {
  const program = new Command();
  program.showSuggestionAfterError();
  program.arguments('<OrderId> <reason> <pausedBy>');
  program.parse();

  const [orderId, reason, pausedBy] = program.args;
  const order = await models.Order.findByPk(orderId, {
    include: [{ association: 'Subscription' }, { association: 'paymentMethod' }],
  });

  if (!order) {
    throw new Error(`Order with id ${orderId} not found`);
  } else if (order.status === OrderStatuses.PAUSED) {
    logger.info(`Order #${orderId} is already paused`);
    return;
  } else if (order.status !== OrderStatuses.ACTIVE) {
    throw new Error(`Order #${orderId} is not active`);
  } else if (!order.Subscription) {
    throw new Error(`Order #${orderId} is not a subscription`);
  } else if (!order.paymentMethod) {
    throw new Error(`Order #${orderId} is missing a payment method`);
  } else if (!Order.isValidPausedBy(pausedBy)) {
    throw new Error(`pausedBy must be one of the following: HOST, PLATFORM, USER`);
  }

  logger.info(
    `Pausing order #${orderId} with payment method ${order.paymentMethod.service}/${order.paymentMethod.type}`,
  );
  if (DRY_RUN) {
    logger.info('Dry run mode enabled, exiting without making changes');
    return;
  } else {
    await pauseOrder(order, reason, pausedBy);
  }
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
