#!/usr/bin/env node
import { map } from 'bluebird';
import '../../server/env';

import models from '../../server/models';
import * as libPayments from '../../server/lib/payments';
import status from '../../server/constants/order_status';

async function run() {
  // fetch orders created from PREPAID tier
  const allOrders = await models.Order.findAll({
    where: {
      status: status.ACTIVE,
    },
    include: [
      {
        model: models.Tier,
        where: { type: 'PREPAID' },
      },
      { model: models.Collective, as: 'fromCollective' },
    ],
  });

  map(allOrders, order => {
    // Amount shareable amongst dependencies
    const shareableAmount = order.totalAmount;
    // Dependecies reciving money
    // - get the url from `order.custonField.jsonUrl`
    // - fetch the dependecies
    const sampleDependecies = [
      { weigh: 50, opencollective: { id: 43, name: 'Apex', slug: 'apex' } },
      { weigh: 100, opencollective: { id: 10887, name: 'Nodejs Tech', slug: 'nodejs-tech' } },
    ];
    const sumOfWeights = sampleDependecies.reduce((sum, dependency) => dependency.weigh + sum, 0);
    map(sampleDependecies, async dependency => {
      // Check if the collective is avaliable
      const collective = await models.Collective.findByPk(dependency.opencollective.id);
      const fromHostId = await order.fromCollective.getHostCollectiveId();
      const totalAmount = computeAmount(shareableAmount, sumOfWeights, dependency.weigh);
      const orderData = {
        createdByUserId: order.createdByUserId,
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: collective.id,
        quantity: order.quantity,
        description: order.description,
        processedAt: new Date(),
        totalAmount,
        currency: order.currency,
        status: status.PENDING,
        paymentMethod: {
          primary: false,
          initalBalance: shareableAmount - totalAmount,
          type: 'prepaid',
          CollectiveId: order.FromCollectiveId,
          service: 'opencollective',
          customerId: order.FromCollectiveId.slug,
          currency: order.currency,
          data: { HostCollectiveId: fromHostId },
        },
      };
      const orderCreated = await models.Order.create(orderData);
      await orderCreated.setPaymentMethod(orderData.paymentMethod);
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
  });
}

const computeAmount = (totalAmount, sumOfWeights, dependencyWeight) => {
  // Express each weight as percentage
  const percentage = (dependencyWeight / sumOfWeights) * 100;
  return Math.round((percentage / 100) * totalAmount);
};

run().catch(err => {
  console.error(err);
});
