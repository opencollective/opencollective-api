#!/usr/bin/env node

import '../../server/env';

import { groupBy, size } from 'lodash';

import { activities } from '../../server/constants';
import logger from '../../server/lib/logger';
import { reportErrorToSentry } from '../../server/lib/sentry';
import { sleep } from '../../server/lib/utils';
import models, { Op } from '../../server/models';

/**
 * Since the collective has been archived, its HostCollectiveId has been set to null.
 * We need some more logic to make sure we're loading the right host.
 */
const getHostFromOrder = async order => {
  const transactions = await order.getTransactions({
    attributes: ['HostCollectiveId'],
    group: ['HostCollectiveId'],
    where: { type: 'CREDIT', kind: 'CONTRIBUTION', HostCollectiveId: { [Op.ne]: null } },
  });

  if (transactions.length !== 1) {
    throw new Error(`Could not find the host for order ${order.id}`);
  }

  return models.Collective.findByPk(transactions[0].HostCollectiveId);
};

/**
 * When archiving collectives. we need to make sure subscriptions managed externally are properly cancelled
 * by calling the right service method (PayPal). We do this asynchronously to properly deal with rate limiting and
 * performance constraints.
 */
export async function run() {
  const orphanOrders = await models.Order.findAll({
    include: [
      {
        model: models.Subscription,
        required: true,
        where: { isManagedExternally: true, isActive: true },
      },
      {
        association: 'collective',
        required: true,
        where: { deactivatedAt: { [Op.not]: null }, isActive: false },
      },
      { association: 'fromCollective' },
      { association: 'paymentMethod' },
    ],
  });

  if (!orphanOrders.length) {
    return;
  }

  const groupedOrders = groupBy(orphanOrders, 'CollectiveId');
  logger.info(`Found ${orphanOrders.length} recurring contributions to cancel across ${size(groupedOrders)} accounts`);

  for (const accountOrders of Object.values(groupedOrders)) {
    const collectiveHandle = accountOrders[0].collective.slug;
    const reason = `@${collectiveHandle} archived their account`;
    logger.info(`Cancelling ${accountOrders.length} subscriptions for @${collectiveHandle}`);
    for (const order of accountOrders) {
      const host = await getHostFromOrder(order);
      logger.debug(`Cancelling order ${order.id} for @${collectiveHandle} (host: ${host.slug})`);
      if (!process.env.DRY) {
        await order.Subscription.deactivate(reason, host);
        await order.update({ status: 'CANCELLED' });
        await models.Activity.create({
          type: activities.SUBSCRIPTION_CANCELED,
          CollectiveId: order.CollectiveId,
          FromCollectiveId: order.FromCollectiveId,
          HostCollectiveId: order.collective.HostCollectiveId,
          OrderId: order.id,
          UserId: order.CreatedByUserId,
          data: {
            subscription: order.Subscription,
            collective: order.collective.minimal,
            fromCollective: order.fromCollective.minimal,
            reasonCode: 'ARCHIVED_ACCOUNT',
            reason: reason,
          },
        });
        await sleep(500); // To prevent rate-limiting issues when calling 3rd party payment processor APIs
      }
    }
  }
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(e => {
      logger.error('Error while cancelling archived accounts subscriptions');
      console.error(e);
      reportErrorToSentry(e);
      process.exit(1);
    });
}
