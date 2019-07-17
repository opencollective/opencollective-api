#!/usr/bin/env node
import debugLib from 'debug';
import moment from 'moment';
import { filter } from 'bluebird';
import { Op } from 'sequelize';

import '../../server/env';

import models from '../../server/models';
import status from '../../server/constants/order_status';
import { dispatchFunds, getNextDispatchingDate } from '../../server/lib/subscriptions';
const debug = debugLib('dispatch_prepaid_subscription');

async function run() {
  // fetch orders created from PREPAID tier
  const allOrders = await models.Order.findAll({
    where: {
      status: status.ACTIVE,
      SubscriptionId: { [Op.ne]: null },
      deletedAt: null,
    },
    include: [
      {
        model: models.Tier,
        where: { type: 'PREPAID' },
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
  }).map(async order => {
    return dispatchFunds(order)
      .then(async createdOrdersId => {
        const nextDispatchDate = getNextDispatchingDate(
          order.Subscription.interval,
          order.Subscription.data.nextDispatchDate,
        );
        order.Subscription.data = { nextDispatchDate };
        order.data = Object.assign(order.data, { lastDispatchedOrdersId: createdOrdersId });
        await order.Subscription.save();
        await order.save();
      })
      .catch(error => {
        debug(`Error occured processing and dispatching order ${order.id}`, error);
        console.error(error);
      });
  });
}

function needsDispatching(nextDispatchDate) {
  const needs = moment(nextDispatchDate).isSameOrBefore();
  return needs;
}

run()
  .then(() => {
    console.log('>>> All subscription dispatched');
    process.exit(0);
  })
  .catch(error => {
    debug('Error when dispatching fund', error);
    console.error(error);
    process.exit();
  });
