#!/usr/bin/env node
import '../../server/env';

import { filter } from 'bluebird';
import { Op } from 'sequelize';

import activities from '../../server/constants/activities';
import status from '../../server/constants/order_status';
import { dispatchFunds, needsDispatching } from '../../server/lib/backyourstack/dispatcher';
import { reportErrorToSentry } from '../../server/lib/sentry';
import models from '../../server/models';

async function run() {
  const tiers = await models.Tier.findAll({
    where: {
      slug: { [Op.iLike]: 'monthly-plan' },
      deletedAt: null,
    },
    include: [
      {
        model: models.Collective,
        where: { slug: 'backyourstack' },
      },
    ],
  });

  if (tiers.length === 0) {
    console.log('Could not find any matching tiers.');
    process.exit(1);
  }

  const tierIds = tiers.map(tier => tier.id);

  const allOrders = await models.Order.findAll({
    where: {
      status: status.ACTIVE,
      SubscriptionId: { [Op.ne]: null },
      deletedAt: null,
    },
    include: [
      {
        model: models.Tier,
        where: { id: { [Op.in]: tierIds } },
      },
      { model: models.Collective, as: 'fromCollective' },
      { model: models.User, as: 'createdByUser' },
      { model: models.Collective, as: 'collective' },
      {
        model: models.Subscription,
        where: {
          isActive: true,
          deletedAt: null,
          deactivatedAt: null,
        },
      },
    ],
  });

  return filter(allOrders, order => {
    return order.Subscription.data && needsDispatching(order.Subscription.data.nextDispatchDate);
  }).map(
    async order => {
      return dispatchFunds(order)
        .then(async dispatchedOrders => {
          const nextDispatchDate = order.Subscription.nextChargeDate;
          order.Subscription.data = { nextDispatchDate };
          await order.Subscription.save();
          await order.save();
          await models.Activity.create({
            type: activities.BACKYOURSTACK_DISPATCH_CONFIRMED,
            UserId: order.CreatedByUserId,
            CollectiveId: order.fromCollective.id, // TODO(InconsistentActivities): Should be Order.CollectiveId
            FromCollectiveId: order.fromCollective.id,
            HostCollectiveId: order.collective.approvedAt ? order.collective.HostCollectiveId : null,
            OrderId: order.id,
            data: {
              orders: dispatchedOrders,
              collective: order.fromCollective.info,
              recurringDispatch: true,
            },
          });
        })
        .catch(error => {
          console.log(`Error occurred processing and dispatching order ${order.id}`);
          console.error(error);
          reportErrorToSentry(error);
        });
    },
    { concurrency: 3 },
  );
}

run()
  .then(() => {
    console.log('>>> All subscription dispatched');
    process.exit(0);
  })
  .catch(error => {
    console.log('Error when dispatching fund');
    console.error(error);
    reportErrorToSentry(error);
    process.exit(1);
  });
