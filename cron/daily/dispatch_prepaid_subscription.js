#!/usr/bin/env node
import fetch from 'isomorphic-fetch';
import { map } from 'bluebird';
import { Op } from 'sequelize';

import '../../server/env';

import models from '../../server/models';
import * as libPayments from '../../server/lib/payments';
import { getNextChargeAndPeriodStartDates } from '../../server/lib/subscriptions';
import status from '../../server/constants/order_status';

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
      { model: models.Collective, as: 'collective' },
      {
        model: models.Subscription,
        where: {
          isActive: true,
          deletedAt: null,
          deactivatedAt: null,
          activatedAt: { [Op.lte]: new Date() },
          nextChargeDate: { [Op.lte]: new Date() },
        },
      },
    ],
  });

  map(allOrders, async order => {
    // Amount shareable amongst dependencies
    const shareableAmount = order.totalAmount;
    const jsonUrl = order.data.customData.jsonUrl;
    const depRecommendation = await fetchDependcies(jsonUrl);
    const sumOfWeights = depRecommendation.reduce((sum, dependency) => dependency.weigh + sum, 0);

    map(depRecommendation, async dependency => {
      // Check if the collective is avaliable
      const collective = await models.Collective.findByPk(dependency.opencollective.id);
      const totalAmount = computeAmount(shareableAmount, sumOfWeights, dependency.weigh);
      const pm = await order.collective.getPaymentMethod({ service: 'opencollective', type: 'prepaid' }, false);

      const orderData = {
        CreatedByUserId: order.CreatedByUserId,
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: collective.id,
        quantity: order.quantity,
        description: order.description,
        processedAt: new Date(),
        totalAmount,
        currency: order.currency,
        status: status.PENDING,
      };

      const orderCreated = await models.Order.create(orderData);
      await orderCreated.setPaymentMethod(pm.uuid);
      try {
        await libPayments.executeOrder(
          // order.fromCollective, Order needs instance of user here not collective
          orderCreated,
        );
      } catch (e) {
        // Don't save new card for user if order failed
        if (!order.paymentMethod.id && !order.paymentMethod.uuid) {
          await orderCreated.paymentMethod.update({ CollectiveId: null });
        }
        throw e;
      }
    });
    // Update the original order subscription for next charge period
    order.Subscription = Object.assign(order.Subscription, getNextChargeAndPeriodStartDates('success', order));
    await order.Subscription.save();
    await order.save();
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

run().catch(err => {
  console.error(err);
});
