import { isEmpty, keys, pick } from 'lodash-es';
import moment from 'moment';

import INTERVALS from '../constants/intervals.js';
import OrderStatus from '../constants/order_status.js';
import { Unauthorized } from '../graphql/errors.js';
import { sequelize } from '../models/index.js';
import { MemberModelInterface } from '../models/Member.js';
import { OrderModelInterface } from '../models/Order.js';
import { PaymentMethodModelInterface } from '../models/PaymentMethod.js';
import Tier from '../models/Tier.js';
import User from '../models/User.js';

import { findPaymentMethodProvider } from './payments.js';

const getIsSubscriptionManagedExternally = pm => {
  const provider = findPaymentMethodProvider(pm);
  return Boolean(provider?.features?.isRecurringManagedExternally);
};

/**
 * When the contribution gets updated, we need to update the next charge date as well
 */
const getNextChargeDateForUpdateContribution = (baseNextChargeDate, newInterval) => {
  const previousNextChargeDate = moment(baseNextChargeDate);
  if (previousNextChargeDate.isBefore(moment())) {
    // If the contribution was pending, keep it in the past
    return previousNextChargeDate;
  } else if (newInterval === 'year') {
    // Yearly => beginning of next year
    return moment().add(1, 'years').startOf('year');
  } else if (previousNextChargeDate.date() > 15) {
    // Set the next charge date to 2 months time if the subscription was made after 15th of the month.
    return moment().add(2, 'months').startOf('month');
  } else {
    // Otherwise, next charge date will be the beginning of the next month
    return moment().add(1, 'months').startOf('month');
  }
};

export const updatePaymentMethodForSubscription = async (
  user: User,
  order: OrderModelInterface,
  newPaymentMethod: PaymentMethodModelInterface,
): Promise<OrderModelInterface> => {
  const prevPaymentMethod = order.paymentMethod;
  const newPaymentMethodCollective = await newPaymentMethod.getCollective();
  if (!user.isAdminOfCollective(newPaymentMethodCollective)) {
    throw new Unauthorized("You don't have permission to use this payment method");
  }

  // Order changes
  const newStatus = order.status === OrderStatus.ERROR ? OrderStatus.ACTIVE : order.status;
  const newOrderData = { PaymentMethodId: newPaymentMethod.id, status: newStatus };

  // Subscription changes
  const newSubscriptionData = { isActive: true, deactivatedAt: null };
  const wasManagedExternally = getIsSubscriptionManagedExternally(prevPaymentMethod);
  const isManagedExternally = getIsSubscriptionManagedExternally(newPaymentMethod);
  if (wasManagedExternally && !isManagedExternally) {
    // Reset flags for managing the subscription externally
    newSubscriptionData['isManagedExternally'] = false;
    newSubscriptionData['paypalSubscriptionId'] = null;

    // Update the next charge dates
    const previousNextChargeDate = order.Subscription.nextChargeDate;
    const interval = order.Subscription.interval;
    const nextChargeDate = getNextChargeDateForUpdateContribution(previousNextChargeDate, interval);
    newSubscriptionData['nextChargeDate'] = nextChargeDate.toDate();
    newSubscriptionData['nextPeriodStart'] = nextChargeDate.toDate();
  }

  // Need to cancel previous subscription
  await order.Subscription.deactivate();
  const { order: updatedOrder } = await updateOrderSubscription(order, null, newOrderData, newSubscriptionData, {});
  return updatedOrder;
};

const checkSubscriptionDetails = (order, tier: Tier, amountInCents) => {
  if (tier && tier.CollectiveId !== order.CollectiveId) {
    throw new Error(`This tier (#${tier.id}) doesn't belong to the given Collective #${order.CollectiveId}`);
  }

  // The amount can never be less than $1.00
  if (amountInCents < 100) {
    throw new Error('Invalid amount.');
  }

  // If using a named tier, amount can never be less than the minimum amount
  if (tier && tier.amountType === 'FLEXIBLE' && amountInCents < tier.minimumAmount) {
    throw new Error('Amount is less than minimum value allowed for this Tier.');
  }

  // If using a FIXED tier, amount cannot be different from the tier's amount
  // TODO: it should be amountInCents !== tier.amount, but we need to do work to make sure that would play well with platform fees/taxes
  if (tier && tier.amountType === 'FIXED' && amountInCents < tier.amount) {
    throw new Error('Amount is incorrect for this Tier.');
  }
};

type OrderSubscriptionUpdate = {
  order: OrderModelInterface;
  previousOrderValues: Record<string, unknown>;
  previousSubscriptionValues: Record<string, unknown>;
};

/**
 * Update the order and the subscription in a single transaction. Returns the modified values
 * for each, to easily rollback if necessary.
 */
export const updateOrderSubscription = async (
  order: OrderModelInterface,
  member: MemberModelInterface,
  newOrderData: Record<string, unknown>,
  newSubscriptionData: Record<string, unknown>,
  newMemberData: Record<string, unknown>,
): Promise<OrderSubscriptionUpdate> => {
  const previousOrderValues = pick(order.dataValues, keys(newOrderData));
  const previousSubscriptionValues = pick(order.Subscription.dataValues, keys(newSubscriptionData));

  if (isEmpty(newOrderData) && isEmpty(newSubscriptionData)) {
    return { order, previousOrderValues, previousSubscriptionValues };
  }

  return sequelize.transaction(async transaction => {
    if (!isEmpty(newOrderData)) {
      order = await order.update(newOrderData, { transaction });
    }

    if (!isEmpty(newSubscriptionData)) {
      order.Subscription = await order.Subscription.update(newSubscriptionData, { transaction });
    }

    if (member && !isEmpty(newMemberData)) {
      member = await member.update(newMemberData, { transaction });
    }

    return { order, member, previousOrderValues, previousSubscriptionValues };
  });
};

export const updateSubscriptionDetails = async (
  order: OrderModelInterface,
  tier: Tier,
  member: MemberModelInterface,
  amountInCents: number,
): Promise<OrderSubscriptionUpdate> => {
  // Make sure the new details are ok values, that match tier's minimum amount if there's one
  checkSubscriptionDetails(order, tier, amountInCents);

  const newOrderData = {};
  const newSubscriptionData = {};
  const newMemberData = {};

  // check if the amount is different from the previous amount
  if (amountInCents !== order.totalAmount) {
    newOrderData['totalAmount'] = amountInCents;
    newSubscriptionData['amount'] = amountInCents;
    // If the order has taxes, we need to update the taxAmount
    if (order.data?.tax?.percentage) {
      const taxRate = order.data.tax.percentage / 100;
      const amountWithoutTip = amountInCents - order.platformTipAmount;
      const grossAmount = amountWithoutTip / (1 + taxRate);
      newOrderData['taxAmount'] = Math.round(amountWithoutTip - grossAmount);
    }
  }

  // Update interval
  if (tier?.interval && tier.interval !== 'flexible' && tier.interval !== order.interval) {
    newOrderData['interval'] = tier.interval;
    newSubscriptionData['interval'] = tier.interval;
  }

  // Update next charge date
  if (
    newOrderData['interval'] &&
    newOrderData['interval'] !== order.interval &&
    newOrderData['interval'] !== INTERVALS.FLEXIBLE
  ) {
    const newInterval = newOrderData['interval'];
    const previousNextChargeDate = order.Subscription.nextChargeDate;
    const nextChargeDate = getNextChargeDateForUpdateContribution(previousNextChargeDate, newInterval);
    newSubscriptionData['nextChargeDate'] = nextChargeDate.toDate();
    newSubscriptionData['nextPeriodStart'] = nextChargeDate.toDate();
  }

  // Update order's Tier
  const newTierId = tier?.id || null;
  if (newTierId !== order.TierId) {
    newOrderData['TierId'] = newTierId;
    newMemberData['TierId'] = newTierId;
  }

  // Backup previous values
  return updateOrderSubscription(order, member, newOrderData, newSubscriptionData, newMemberData);
};
