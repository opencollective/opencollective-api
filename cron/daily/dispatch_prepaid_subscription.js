#!/usr/bin/env node
import fetch from 'isomorphic-fetch';
import uuidV4 from 'uuid/v4';
import debugLib from 'debug';
import moment from 'moment';
import { map, filter } from 'bluebird';
import { Op } from 'sequelize';

import '../../server/env';

import models from '../../server/models';
import * as libPayments from '../../server/lib/payments';
import status from '../../server/constants/order_status';

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
    // Amount shareable amongst dependencies
    const shareableAmount = order.totalAmount;
    const jsonUrl = order.data.customData.jsonUrl;
    const depRecommendation = await fetchDependcies(jsonUrl);
    const sumOfWeights = depRecommendation.reduce((sum, dependency) => dependency.weigh + sum, 0);
    const HostCollectiveId = await order.collective.getHostCollectiveId();

    const paymentMethod = await models.PaymentMethod.create({
      initialBalance: shareableAmount,
      currency: order.currency,
      CollectiveId: order.FromCollectiveId,
      customerId: order.fromCollective.slug,
      service: 'opencollective',
      type: 'prepaid',
      uuid: uuidV4(),
      data: { HostCollectiveId },
    });

    return map(depRecommendation, async dependency => {
      // Check if the collective is avaliable
      const collective = await models.Collective.findByPk(dependency.opencollective.id);
      const totalAmount = computeAmount(shareableAmount, sumOfWeights, dependency.weigh);

      const orderData = {
        CreatedByUserId: order.CreatedByUserId,
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: collective.id,
        quantity: order.quantity,
        description: order.description,
        totalAmount,
        currency: order.currency,
        status: status.PENDING,
      };
      const orderCreated = await models.Order.create(orderData);
      await orderCreated.setPaymentMethod(paymentMethod);
      await orderCreated.reload();

      try {
        await libPayments.executeOrder(order.createdByUser, orderCreated);
      } catch (e) {
        debug(`Error occured excuting order ${orderCreated.id}`, e);
        throw e;
      }
      return;
    })
      .then(async () => {
        const nextDispatchDate = getNextDispatchingDate(
          order.Subscription.interval,
          order.Subscription.data.nextDispatchDate,
        );
        order.Subscription.data = { nextDispatchDate };
        await order.Subscription.save();
        await order.save();
      })
      .catch(error => {
        debug(`Error occured processing and dispatching order ${order.id}`, error);
        console.error(error);
      });
  });
}

const computeAmount = (totalAmount, sumOfWeights, dependencyWeight) => {
  // Express each weight as percentage
  const percentage = (dependencyWeight / sumOfWeights) * 100;
  return Math.round((percentage / 100) * totalAmount);
};

const fetchDependcies = jsonUrl => {
  return fetch(jsonUrl).then(res => res.json());
};

function needsDispatching(nextDispatchDate) {
  const needs = moment(nextDispatchDate).isSameOrBefore();
  return needs;
}

function getNextDispatchingDate(interval, currentDispatchDate) {
  const nextDispatchDate = moment(currentDispatchDate);
  if (interval === 'month') {
    nextDispatchDate.add(1, 'months');
  } else if (interval === 'year') {
    nextDispatchDate.add(1, 'years');
  }
  return nextDispatchDate.toDate();
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
