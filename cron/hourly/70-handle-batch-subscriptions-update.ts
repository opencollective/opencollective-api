#!/usr/bin/env node

import '../../server/env';

import { groupBy, size, sortBy, uniq } from 'lodash';
import moment from 'moment';

import { activities } from '../../server/constants';
import FEATURE from '../../server/constants/feature';
import OrderStatuses from '../../server/constants/order-status';
import logger from '../../server/lib/logger';
import { reportErrorToSentry } from '../../server/lib/sentry';
import { parseToBoolean, sleep } from '../../server/lib/utils';
import models, { Collective, Op } from '../../server/models';
import Order from '../../server/models/Order';
import { CONTRIBUTION_PAUSED_MSG } from '../../server/paymentProviders/paypal/subscription';

if (parseToBoolean(process.env.SKIP_BATCH_SUBSCRIPTION_UPDATE)) {
  console.log('Skipping because SKIP_BATCH_SUBSCRIPTION_UPDATE is set.');
  process.exit();
}

const HostsCache = {};

/**
 * If the collective has been archived, its HostCollectiveId has been set to null.
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
    // If there is no transaction, it could be that the order hasn't been processed yet. We can safely assume
    // that the current collective host (if any) is the right one.
    return order.collective.getHostCollective();
  }

  const hostId = hostIds[0]; // Take the most recent transaction's host
  if (!HostsCache[hostId]) {
    HostsCache[hostId] = await models.Collective.findByPk(hostId);
  }
  return HostsCache[hostId];
};

const getOrderCancelationReason = (
  collective: Collective,
  order: Order,
  orderHost: Collective,
): {
  code: 'PAUSED' | 'DELETED_TIER' | 'ARCHIVED_ACCOUNT' | 'UNHOSTED_COLLECTIVE' | 'CHANGED_HOST' | 'CANCELLED_ORDER';
  message: string;
} => {
  if (order.status === 'PAUSED') {
    return { code: 'PAUSED', message: CONTRIBUTION_PAUSED_MSG };
  } else if (order.TierId && !order.Tier) {
    return { code: 'DELETED_TIER', message: `Order tier deleted` };
  } else if (collective.deactivatedAt) {
    return { code: 'ARCHIVED_ACCOUNT', message: `@${collective.slug} archived their account` };
  } else if (!collective.HostCollectiveId) {
    return { code: 'UNHOSTED_COLLECTIVE', message: `@${collective.slug} was un-hosted` };
  } else if (collective.HostCollectiveId !== orderHost.id) {
    return { code: 'CHANGED_HOST', message: `@${collective.slug} changed host` };
  } else {
    return { code: 'CANCELLED_ORDER', message: `Order cancelled` };
  }
};

/**
 * When archiving collectives. we need to make sure subscriptions managed externally are properly cancelled
 * by calling the right service method (PayPal). We do this asynchronously to properly deal with rate limiting and
 * performance constraints.
 */
export async function run() {
  const orphanOrders = await models.Order.findAll<Order>({
    where: {
      status: [OrderStatuses.CANCELLED, OrderStatuses.PAUSED],
      data: { needsAsyncDeactivation: true },
      updatedAt: {
        [Op.gt]: moment().subtract(1, 'month').toDate(), // For performance, only look at orders updated recently
      },
    },
    include: [
      {
        model: models.Tier,
        as: 'Tier',
        required: false,
      },
      {
        model: models.Subscription,
        required: true,
        where: { isActive: true },
      },
      { association: 'collective', required: true },
      { association: 'fromCollective' },
      { association: 'paymentMethod' },
    ],
    order: [['id', 'ASC']],
    limit: parseInt(process.env.LIMIT) || 5000,
  });

  if (!orphanOrders.length) {
    return;
  }

  const groupedOrders = groupBy(orphanOrders, 'CollectiveId');
  logger.info(`Found ${orphanOrders.length} recurring contributions to cancel across ${size(groupedOrders)} accounts`);

  for (const accountOrders of Object.values(groupedOrders)) {
    const sortedAccountOrders = sortBy(accountOrders, ['Subscription.isManagedExternally']);
    const collective = sortedAccountOrders[0].collective;
    const collectiveHandle = collective.slug;
    logger.info(`Cancelling ${sortedAccountOrders.length} subscriptions for @${collectiveHandle}`);
    for (const order of sortedAccountOrders) {
      try {
        logger.debug(`Cancelling subscription ${order.Subscription.id} from order ${order.id} of @${collectiveHandle}`);
        const host = await getHostFromOrder(order);
        logger.debug(`Host fetched: ${host.slug}`);

        const reason = getOrderCancelationReason(collective, order, host);
        if (!process.env.DRY) {
          await order.Subscription.deactivate(reason.message, host);
          logger.debug('Creating the activity and sending email');
          await models.Activity.create({
            type: reason.code === 'PAUSED' ? activities.SUBSCRIPTION_PAUSED : activities.SUBSCRIPTION_CANCELED,
            CollectiveId: order.CollectiveId,
            FromCollectiveId: order.FromCollectiveId,
            HostCollectiveId: order.collective.HostCollectiveId,
            OrderId: order.id,
            UserId: order.CreatedByUserId,
            data: {
              subscription: order.Subscription,
              collective: order.collective.minimal,
              fromCollective: order.fromCollective.minimal,
              reasonCode: reason.code,
              reason: reason.message,
              messageForContributors: order.data?.messageForContributors,
              messageSource: order.data?.messageSource,
              isOCFShutdown: order.data?.isOCFShutdown,
              order: order.info,
              tier: order.Tier?.info,
              awaitForDispatch: true, // To make sure we won't kill the process while emails are still being sent
            },
          });

          logger.debug('Updating order');
          await order.update({ data: { ...order.data, needsAsyncDeactivation: false } });
          if (order.Subscription.isManagedExternally) {
            await sleep(500); // To prevent rate-limiting issues when calling 3rd party payment processor APIs
          }
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

  console.log('Done!');
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
