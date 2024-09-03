import '../../server/env';

import { groupBy, omit, size, sortBy, uniq } from 'lodash';
import moment from 'moment';

import { activities } from '../../server/constants';
import FEATURE from '../../server/constants/feature';
import OrderStatuses from '../../server/constants/order-status';
import logger from '../../server/lib/logger';
import { findPaymentMethodProvider } from '../../server/lib/payments';
import { reportErrorToSentry } from '../../server/lib/sentry';
import { parseToBoolean, sleep } from '../../server/lib/utils';
import models, { Collective, Op } from '../../server/models';
import Order from '../../server/models/Order';
import { CONTRIBUTION_PAUSED_MSG } from '../../server/paymentProviders/paypal/subscription';
import { isPaymentProviderWithExternalRecurring } from '../../server/paymentProviders/types';
import { runCronJob } from '../utils';

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

type StatusChangeReason = {
  code: 'PAUSED' | 'DELETED_TIER' | 'ARCHIVED_ACCOUNT' | 'UNHOSTED_COLLECTIVE' | 'CHANGED_HOST' | 'CANCELLED_ORDER';
  message: string;
};

const getStatusChangeReason = (collective: Collective, order: Order, orderHost: Collective): StatusChangeReason => {
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

const createActivity = (
  order: Order,
  reason: StatusChangeReason,
  type: activities.SUBSCRIPTION_PAUSED | activities.SUBSCRIPTION_CANCELED | activities.SUBSCRIPTION_ACTIVATED,
  additionalData = {},
) => {
  return models.Activity.create({
    type,
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
      messageForContributors: order.data.messageForContributors,
      messageSource: order.data.messageSource,
      order: order.info,
      tier: order.Tier?.info,
      awaitForDispatch: true, // To make sure we won't kill the process while emails are still being sent
      ...additionalData,
    },
  });
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
      [Op.or]: [
        { data: { needsAsyncDeactivation: true }, '$Subscription.isActive$': true },
        { data: { needsAsyncPause: true }, '$Subscription.isActive$': true },
        { data: { needsAsyncReactivation: true }, '$Subscription.isActive$': false },
      ],
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
      { model: models.Subscription, required: true },
      { association: 'collective', required: true },
      { association: 'fromCollective' },
      { association: 'paymentMethod' },
    ],
    order: [['id', 'ASC']],
    limit: parseInt(process.env.LIMIT) || 5000,
  });

  if (!orphanOrders.length) {
    return [];
  }

  const orphanOrdersIds = orphanOrders.map(o => o.id);
  const groupedOrders = groupBy(orphanOrders, 'CollectiveId');
  logger.info(`Found ${orphanOrders.length} recurring contributions to update across ${size(groupedOrders)} accounts`);

  for (const accountOrders of Object.values(groupedOrders)) {
    const sortedAccountOrders = sortBy(accountOrders, ['Subscription.isManagedExternally']);
    const collective = sortedAccountOrders[0].collective;
    const collectiveHandle = collective.slug;
    logger.info(`Updating ${sortedAccountOrders.length} subscriptions for @${collectiveHandle}`);
    for (const order of sortedAccountOrders) {
      try {
        const host = await getHostFromOrder(order);
        const reason = getStatusChangeReason(collective, order, host);

        if (order.data.needsAsyncDeactivation) {
          logger.debug(
            `Cancelling subscription ${order.Subscription.id} from order ${order.id} of @${collectiveHandle}`,
          );
          if (!process.env.DRY) {
            logger.debug('Deactivating subscription');
            await order.Subscription.deactivate(reason.message, host);
            logger.debug('Updating order');
            await order.update({ data: { ...order.data, needsAsyncDeactivation: false } });
            logger.debug('Creating the activity and sending email');
            const activityType =
              reason.code === 'PAUSED' ? activities.SUBSCRIPTION_PAUSED : activities.SUBSCRIPTION_CANCELED;
            await createActivity(order, reason, activityType, { isOCFShutdown: order.data.isOCFShutdown });
          }
        } else if (order.data.needsAsyncReactivation) {
          logger.debug(
            `Reactivating subscription ${order.Subscription.id} from order ${order.id} of @${collectiveHandle}`,
          );
          if (!process.env.DRY) {
            const paymentMethodProvider = findPaymentMethodProvider(order.paymentMethod);
            if (isPaymentProviderWithExternalRecurring(paymentMethodProvider)) {
              await paymentMethodProvider.resumeSubscription(order, order.data.messageForContributors);
            }

            logger.debug('Updating order');
            await order.update({
              status: OrderStatuses.ACTIVE,
              data: omit(order.data, ['needsAsyncReactivation', 'createStatusChangeActivity']),
            });
            logger.debug('Updating subscription');
            await order.Subscription.update({ isActive: true, deactivatedAt: null });

            if (order.data.createStatusChangeActivity) {
              logger.debug('Creating the activity and sending email');
              await createActivity(order, reason, activities.SUBSCRIPTION_ACTIVATED);
            }
          }
        } else if (order.data.needsAsyncPause) {
          logger.debug(`Pausing subscription ${order.Subscription.id} from order ${order.id} of @${collectiveHandle}`);
          if (!process.env.DRY) {
            const paymentMethodProvider = findPaymentMethodProvider(order.paymentMethod);
            if (isPaymentProviderWithExternalRecurring(paymentMethodProvider)) {
              await paymentMethodProvider.pauseSubscription(order, order.data.messageForContributors);
            }

            logger.debug('Updating order');
            await order.update({
              status: OrderStatuses.PAUSED,
              data: omit(order.data, ['needsAsyncPause', 'createStatusChangeActivity']),
            });
            logger.debug('Updating subscription');
            await order.Subscription.update({ isActive: false, deactivatedAt: new Date() });

            if (order.data.createStatusChangeActivity) {
              logger.debug('Creating the activity and sending email');
              await createActivity(order, reason, activities.SUBSCRIPTION_PAUSED);
            }
          }
        }

        // To prevent rate-limiting issues when calling 3rd party payment processor APIs
        if (order.Subscription.isManagedExternally) {
          await sleep(500);
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
  return orphanOrdersIds;
}

if (require.main === module) {
  runCronJob('handle-batch-subscriptions-update', run, 60 * 60);
}
