import config from 'config';
import { isEmpty, keys, pick } from 'lodash';
import moment from 'moment';

import INTERVALS from '../constants/intervals';
import OrderStatus from '../constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../constants/paymentMethods';
import { BadRequest, Unauthorized, UnexpectedError } from '../graphql/errors';
import { Member, sequelize } from '../models';
import Order from '../models/Order';
import PaymentMethod from '../models/PaymentMethod';
import Tier from '../models/Tier';
import User from '../models/User';

import { findPaymentMethodProvider } from './payments';

const getIsSubscriptionManagedExternally = pm => {
  const provider = findPaymentMethodProvider(pm);
  return Boolean(provider?.features?.isRecurringManagedExternally);
};

/**
 * When the contribution gets updated, we need to update the next charge date as well.
 *
 * If reactivating the contribution on the same interval (month/year), keep the previous "next charge date". Otherwise,
 * set the next charge date to the beginning of the next interval.
 */
const getNextChargeDateForUpdateContribution = (
  baseNextChargeDate: Date,
  newInterval: Order['interval'],
  prevInterval: Order['interval'],
  supportsOffCycle: boolean,
) => {
  const previousNextChargeDate = moment(baseNextChargeDate);
  const maxDiffInDaysToReusePreviousNextChargeDate = newInterval === 'month' ? 25 : 340; // 25 days for monthly, 340 days for yearly
  const now = moment();
  const nextChargeIsFuture = previousNextChargeDate.isAfter(now);
  const isKeepingInterval = newInterval === prevInterval;

  // We allow re-using the previous next charge date if it's no too old or if the next charge date is in the future (and the new date is supported)
  if (nextChargeIsFuture) {
    if (isKeepingInterval && (supportsOffCycle || previousNextChargeDate.date() === 1)) {
      return previousNextChargeDate;
    }
  } else if (now.diff(previousNextChargeDate, 'days') < maxDiffInDaysToReusePreviousNextChargeDate) {
    return previousNextChargeDate;
  }

  // Otherwise, we need to calculate the next charge date
  if (newInterval === 'year') {
    // Yearly => beginning of next year
    return now.add(1, 'years').startOf('year');
  } else if (now.date() === 1 && !nextChargeIsFuture) {
    // When updating from yearly to monthly on the first day of the month, we can charge today
    return supportsOffCycle ? now : now.startOf('month');
  } else if (previousNextChargeDate.date() > 15) {
    // Set the next charge date to 2 months time if the subscription was made after 15th of the month.
    return now.add(2, 'months').startOf('month');
  } else {
    // Otherwise, next charge date will be the beginning of the next month
    return now.add(1, 'months').startOf('month');
  }
};

export const updatePaymentMethodForSubscription = async (
  user: User,
  order: Order,
  newPaymentMethod: PaymentMethod,
): Promise<Order> => {
  const newPaymentMethodCollective = await newPaymentMethod.getCollective();
  if (!user.isAdminOfCollective(newPaymentMethodCollective)) {
    throw new Unauthorized("You don't have permission to use this payment method");
  }

  if (newPaymentMethod.service === PAYMENT_METHOD_SERVICE.STRIPE) {
    const orderCollective = await order.getCollective();
    if (!orderCollective) {
      throw new UnexpectedError('Order collective not found');
    }
    const host = await orderCollective.getHostCollective();
    if (!host) {
      throw new UnexpectedError('Order host not found');
    }

    const [hostStripeAccount] = await host.getConnectedAccounts({
      where: { service: 'stripe' },
      limit: 1,
    });

    if (!hostStripeAccount) {
      throw new UnexpectedError('Host stripe account not found');
    }

    // cards attached to the platform account can be copied
    const isPlatformAccountCreditCard =
      newPaymentMethod.type === PAYMENT_METHOD_TYPE.CREDITCARD &&
      (!newPaymentMethod.data?.stripeAccount || newPaymentMethod.data?.stripeAccount === config.stripe.accountId);

    if (!isPlatformAccountCreditCard && newPaymentMethod.data.stripeAccount !== hostStripeAccount.username) {
      throw new BadRequest('This payment method is not valid for the order host');
    }
  }

  // Order changes
  const newStatus = [OrderStatus.ERROR, OrderStatus.PAUSED].includes(order.status) ? OrderStatus.ACTIVE : order.status;
  const newOrderData = { PaymentMethodId: newPaymentMethod.id, status: newStatus };

  // Subscription changes
  const newSubscriptionData = { isActive: true, deactivatedAt: null };
  const isManagedExternally = getIsSubscriptionManagedExternally(newPaymentMethod);

  if (!isManagedExternally) {
    // Reset flags for managing the subscription externally
    newSubscriptionData['isManagedExternally'] = false;
    newSubscriptionData['paypalSubscriptionId'] = null;

    // Update the next charge dates
    const previousNextChargeDate = order.Subscription.nextChargeDate;
    const interval = order.Subscription.interval;
    const nextChargeDate = getNextChargeDateForUpdateContribution(previousNextChargeDate, interval, interval, false);
    newSubscriptionData['nextChargeDate'] = nextChargeDate.toDate();
    newSubscriptionData['nextPeriodStart'] = nextChargeDate.toDate();
  }

  // Need to cancel previous subscription
  if (order.Subscription.isActive) {
    await order.Subscription.deactivate();
  }

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
  order: Order;
  previousOrderValues: Record<string, unknown>;
  previousSubscriptionValues: Record<string, unknown>;
};

/**
 * Update the order and the subscription in a single transaction. Returns the modified values
 * for each, to easily rollback if necessary.
 */
export const updateOrderSubscription = async (
  order: Order,
  member: Member,
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
  order: Order,
  tier: Tier,
  member: Member,
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
    const prevInterval = order.interval;
    const newInterval = newOrderData['interval'];
    const previousNextChargeDate = order.Subscription.nextChargeDate;
    const supportsOffCycle = getIsSubscriptionManagedExternally(order.paymentMethod);
    const nextChargeDate = getNextChargeDateForUpdateContribution(
      previousNextChargeDate,
      newInterval,
      prevInterval,
      supportsOffCycle,
    );
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
