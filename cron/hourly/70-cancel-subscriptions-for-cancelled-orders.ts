#!/usr/bin/env node

import '../../server/env';

import { groupBy, size } from 'lodash';

import { activities } from '../../server/constants';
import OrderStatuses from '../../server/constants/order_status';
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

const getOrderCancelationReason = (collective, order, orderHost) => {
  if (order.TierId && !order.Tier) {
    return ['DELETED_TIER', `Order tier deleted`];
  } else if (collective.deactivatedAt) {
    return ['ARCHIVED_ACCOUNT', `@${collective.slug} archived their account`];
  } else if (!collective.HostCollectiveId) {
    return ['UNHOSTED_COLLECTIVE', `@${collective.slug} was un-hosted`];
  } else if (collective.HostCollectiveId !== orderHost.id) {
    return ['CHANGED_HOST', `@${collective.slug} changed host`];
  } else {
    return ['CANCELLED_ORDER', `Order cancelled`];
  }
};

/**
 * When archiving collectives. we need to make sure subscriptions managed externally are properly cancelled
 * by calling the right service method (PayPal). We do this asynchronously to properly deal with rate limiting and
 * performance constraints.
 */
export async function run() {
  const orphanOrders = await models.Order.findAll({
    where: { status: OrderStatuses.CANCELLED },
    include: [
      {
        model: models.Tier,
      },
      {
        model: models.Subscription,
        required: true,
        where: { isActive: true },
      },
      { association: 'collective', require: true },
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
    const collective = accountOrders[0].collective;
    const collectiveHandle = collective.slug;
    logger.info(`Cancelling ${accountOrders.length} subscriptions for @${collectiveHandle}`);
    for (const order of accountOrders) {
      const host = await getHostFromOrder(order);
      const [reasonCode, reason] = getOrderCancelationReason(collective, order, host);
      logger.debug(
        `Cancelling subscription ${order.Subscription.id} from order ${order.id} of @${collectiveHandle} (host: ${host.slug})`,
      );
      if (!process.env.DRY) {
        await order.Subscription.deactivate(reason, host);
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
            reasonCode: reasonCode,
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
