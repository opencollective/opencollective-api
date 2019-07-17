/** @module lib/subscriptions */

import fetch from 'isomorphic-fetch';
import uuidV4 from 'uuid/v4';
import debugLib from 'debug';
import { map } from 'bluebird';
import models from '../models';
import moment from 'moment';

import status from '../constants/order_status';
import * as paymentsLib from './payments';

export function getNextDispatchingDate(interval, currentDispatchDate) {
  const nextDispatchDate = moment(currentDispatchDate);
  if (interval === 'month') {
    nextDispatchDate.add(1, 'months');
  } else if (interval === 'year') {
    nextDispatchDate.add(1, 'years');
  }
  return nextDispatchDate.toDate();
}

function computeAmount(totalAmount, sumOfWeights, dependencyWeight) {
  // Express each weight as percentage
  const percentage = (dependencyWeight / sumOfWeights) * 100;
  return Math.round((percentage / 100) * totalAmount);
}

function fetchDependencies(jsonUrl) {
  return fetch(jsonUrl).then(res => res.json());
}

export async function dispatchFunds(order) {
  console.log(order);
  const debug = debugLib('dispatch_prepaid_subscription');
  // Amount shareable amongst dependencies
  const transaction = await models.Transaction.findOne({
    where: { OrderId: order.id, type: 'CREDIT' },
  });
  const shareableAmount = transaction.netAmountInCollectiveCurrency;
  const jsonUrl = order.data.customData.jsonUrl;
  let depRecommendation;

  try {
    depRecommendation = await fetchDependencies(jsonUrl);
  } catch (err) {
    debug('Error fetching dependcies', err);
    console.error(err);
    throw new Error('Unable to fetch dependencies, please ensure the url is correct');
  }

  const sumOfWeights = depRecommendation.reduce((sum, dependency) => dependency.weight + sum, 0);
  let HostCollectiveId;
  if (!order.collective) {
    const collective = await models.Collective.findByPk(order.CollectiveId);
    HostCollectiveId = await collective.getHostCollectiveId();
  } else {
    HostCollectiveId = await order.collective.getHostCollectiveId();
  }

  if (!order.fromCollective) {
    order.fromCollective = await models.Collective.findByPk(order.FromCollectiveId);
  }

  if (!order.createdByUser) {
    order.createdByUser = await models.User.findByPk(order.CreatedByUserId);
  }

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
    const totalAmount = computeAmount(shareableAmount, sumOfWeights, dependency.weight);

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
      await paymentsLib.executeOrder(order.createdByUser, orderCreated);
    } catch (e) {
      debug(`Error occured excuting order ${orderCreated.id}`, e);
      throw e;
    }
    return orderCreated;
  });
}
