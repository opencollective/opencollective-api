#!/usr/bin/env node

import '../../server/env';

import { groupBy, size, uniq } from 'lodash';

import { activities } from '../../server/constants';
import FEATURE from '../../server/constants/feature';
import OrderStatuses from '../../server/constants/order-status';
import logger from '../../server/lib/logger';
import { reportErrorToSentry } from '../../server/lib/sentry';
import { sleep } from '../../server/lib/utils';
import models, { Op } from '../../server/models';
import { OrderModelInterface } from '../../server/models/Order';

/**
 * Since the collective has been archived, its HostCollectiveId has been set to null.
 * We need some more logic to make sure we're loading the right host.
 */
const getHostFromOrder = async order => {
  const transactions = await order.getTransactions({
    attributes: ['HostCollectiveId'],
    where: { type: 'CREDIT', kind: 'CONTRIBUTION', HostCollectiveId: { [Op.ne]: null } },
    order: [['createdAt', 'DESC']],
  });

  const hostIds: number[] = uniq(transactions.map(t => t.HostCollectiveId));
  if (!hostIds.length) {
    throw new Error(`Could not find the host for order ${order.id}`);
  }

  return models.Collective.findByPk(hostIds[0]);
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
  const orphanOrders = await models.Order.findAll<OrderModelInterface>({
    where: { status: OrderStatuses.CANCELLED },
    include: [
      {
        association: 'Tier',
        required: false,
      },
      {
        association: 'Subscription',
        required: true,
        where: { isActive: true },
      },
      { association: 'collective', required: true },
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
      try {
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
              order: order.info,
              tier: order.Tier?.info,
            },
          });
          await sleep(500); // To prevent rate-limiting issues when calling 3rd party payment processor APIs
        }
      } catch (e) {
        logger.error(`Error while cancelling subscriptions for @${collectiveHandle}: ${e.message}`);
        reportErrorToSentry(e, {
          feature: FEATURE.RECURRING_CONTRIBUTIONS,
          severity: 'error',
          extra: { collectiveHandle, order: order.info },
        });
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
