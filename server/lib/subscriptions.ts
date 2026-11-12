import config from 'config';
import { isEmpty, keys, omit, pick } from 'lodash';
import moment from 'moment';
import type { Transaction as SequelizeTransaction } from 'sequelize';

import INTERVALS from '../constants/intervals';
import OrderStatus from '../constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../constants/paymentMethods';
import { assertOrderAmountMatchesTier } from '../graphql/common/orders';
import { BadRequest, Unauthorized, UnexpectedError, ValidationFailed } from '../graphql/errors';
import { sequelize } from '../models';
import Order from '../models/Order';
import PaymentMethod from '../models/PaymentMethod';
import Tier from '../models/Tier';
import User from '../models/User';

import { roundCentsAmount } from './currency';
import { doesAmountSatisfyTier, getLastPaidAmount, syncBackerMembershipTier } from './order-tier-change';
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
  baseNextPeriodStart: Date,
  newInterval: Order['interval'],
  prevInterval: Order['interval'],
  allowReuseOfFutureOffCycleNextChargeDate: boolean,
): [nextChargeDate: moment.Moment, nextPeriodStart: moment.Moment] => {
  const previousNextChargeDate = moment(baseNextChargeDate);
  const previousNextPeriodStart = moment(baseNextPeriodStart);
  const maxDiffInDaysToReusePreviousNextChargeDate = newInterval === 'month' ? 25 : 340; // 25 days for monthly, 340 days for yearly
  const now = moment();
  const nextChargeIsFuture = previousNextChargeDate.isAfter(now);
  const isKeepingInterval = newInterval === prevInterval;

  // We allow re-using the previous next charge date if it's no too old or if the next charge date is in the future (and the new date is supported)
  if (nextChargeIsFuture) {
    if (isKeepingInterval && (allowReuseOfFutureOffCycleNextChargeDate || previousNextChargeDate.date() === 1)) {
      return [previousNextChargeDate, previousNextPeriodStart];
    }
  } else if (now.diff(previousNextChargeDate, 'days') < maxDiffInDaysToReusePreviousNextChargeDate) {
    return [previousNextChargeDate, previousNextPeriodStart];
  }

  // Otherwise, we need to calculate the next charge date
  if (newInterval === 'year') {
    const newDates = now.add(1, 'years').startOf('year');
    // Yearly => beginning of next year
    return [newDates, newDates];
  } else if (now.date() === 1 && !nextChargeIsFuture) {
    const newDates = now.startOf('month');
    // When updating from yearly to monthly on the first day of the month, we can charge today
    return [newDates, newDates];
  } else if (previousNextChargeDate.date() > 15) {
    // Set the next charge date to 2 months time if the subscription was made after 15th of the month.
    const newDates = now.add(2, 'months').startOf('month');
    return [newDates, newDates];
  } else {
    // Otherwise, next charge date will be the beginning of the next month
    const newDates = now.add(1, 'months').startOf('month');
    return [newDates, newDates];
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

  // Ensure that this payment method can be used for this order
  await newPaymentMethod.canBeUsedForOrder(order, user);

  // Order changes
  const newStatus = [OrderStatus.ERROR, OrderStatus.PAUSED].includes(order.status) ? OrderStatus.ACTIVE : order.status;
  const newOrderData = { PaymentMethodId: newPaymentMethod.id, status: newStatus };

  // Subscription changes
  const newSubscriptionData = { isActive: true, deactivatedAt: null };
  const isNewPaymentMethodManagedExternally = getIsSubscriptionManagedExternally(newPaymentMethod);

  if (!isNewPaymentMethodManagedExternally) {
    // Reset flags for managing the subscription externally
    newSubscriptionData['isManagedExternally'] = false;
    newSubscriptionData['paypalSubscriptionId'] = null;

    // Update the next charge dates
    const previousNextChargeDate = order.Subscription.nextChargeDate;
    const previousNextPeriodStart = order.Subscription.nextPeriodStart;
    const interval = order.Subscription.interval;
    const changedFromExternallyManagedToInternallyManaged = order.Subscription.isManagedExternally;
    const [nextChargeDate, nextPeriodStart] = getNextChargeDateForUpdateContribution(
      previousNextChargeDate,
      previousNextPeriodStart,
      interval,
      interval,
      !changedFromExternallyManagedToInternallyManaged,
    );

    newSubscriptionData['nextChargeDate'] = nextChargeDate.toDate();
    newSubscriptionData['nextPeriodStart'] = nextPeriodStart.toDate();
  }

  // Need to cancel previous subscription
  if (order.Subscription.isActive) {
    await order.Subscription.deactivate();
  }

  const { order: updatedOrder } = await updateOrderSubscription(order, newOrderData, newSubscriptionData);
  return updatedOrder;
};

const checkSubscriptionDetails = (order, tier: Tier, amountInCents) => {
  if (tier && tier.CollectiveId !== order.CollectiveId) {
    throw new ValidationFailed(`This tier (#${tier.id}) doesn't belong to the given Collective #${order.CollectiveId}`);
  }

  // The amount can never be less than $1.00
  if (amountInCents < 100) {
    throw new ValidationFailed('Invalid amount.');
  }

  // Make sure the amount matches the tier (fixed amount or minimum). `amountInCents` excludes platform
  // tips but includes taxes: tier amounts are pre-tax, so we compare the net amount for the collective.
  const taxPercentage = order.data?.tax?.percentage || 0;
  const baseAmountInCents = taxPercentage
    ? roundCentsAmount(amountInCents / (1 + taxPercentage / 100), order.currency)
    : amountInCents;
  assertOrderAmountMatchesTier(tier, {
    baseAmountInCents,
    totalAmountInCents: amountInCents + (order.platformTipAmount || 0),
    quantity: order.quantity,
    currency: order.currency,
    taxPercentage,
  });
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
  newOrderData: Record<string, unknown>,
  newSubscriptionData: Record<string, unknown> = undefined,
  { onUpdate }: { onUpdate?: (transaction: SequelizeTransaction) => Promise<void> } = {},
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

    if (onUpdate) {
      await onUpdate(transaction);
    }

    return { order, previousOrderValues, previousSubscriptionValues };
  });
};

/**
 * - `NONE`: the tier is unchanged
 * - `APPLIED`: the tier changed immediately (the latest charge already pays for it, or no tier)
 * - `PENDING`: the tier will change once a charge pays for it, see `server/lib/order-tier-change.ts`
 * - `PENDING_CANCELLED`: a pending tier change was dropped (e.g. the contributor went back to their current tier)
 */
type SubscriptionTierChange = 'NONE' | 'APPLIED' | 'PENDING' | 'PENDING_CANCELLED';

type SubscriptionDetailsUpdate = OrderSubscriptionUpdate & {
  tierChange: SubscriptionTierChange;
  previousTierId: number | null;
  requestedTierId: number | null;
};

export const updateSubscriptionDetails = async (
  order: Order,
  tier: Tier,
  amountInCents: number,
  platformTipAmount: number = order.platformTipAmount,
  { remoteUser }: { remoteUser?: User } = {},
): Promise<SubscriptionDetailsUpdate> => {
  if (platformTipAmount < 0) {
    throw new ValidationFailed('Platform tip amount cannot be negative');
  }
  // Make sure the new details are ok values, that match tier's minimum amount if there's one.
  // Validate against the contribution amount excluding the platform tip, since the tip goes to
  // the platform rather than the tier/collective.
  const netContribution = Math.max(0, amountInCents - (platformTipAmount || 0));
  checkSubscriptionDetails(order, tier, netContribution);

  const newOrderData = {};
  const newSubscriptionData = {};
  let newData = order.data;

  // check if the amount is different from the previous amount
  if (amountInCents !== order.totalAmount) {
    newOrderData['totalAmount'] = amountInCents;
    newSubscriptionData['amount'] = amountInCents;
  }

  if (platformTipAmount !== order.platformTipAmount) {
    newOrderData['platformTipAmount'] = platformTipAmount;
  }

  // Recompute the back-derived tax whenever the post-tax amount (total minus tip) changes.
  const previousAmountWithoutTip = order.totalAmount - order.platformTipAmount;
  const nextAmountWithoutTip = amountInCents - platformTipAmount;
  const grossChanged = nextAmountWithoutTip !== previousAmountWithoutTip;
  if (order.data?.tax?.percentage && grossChanged) {
    const taxRate = order.data.tax.percentage / 100;
    const grossAmount = nextAmountWithoutTip / (1 + taxRate);
    newOrderData['taxAmount'] = roundCentsAmount(nextAmountWithoutTip - grossAmount, order.currency);
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
    const previousNextPeriodStart = order.Subscription.nextPeriodStart;
    const supportsOffCycle = getIsSubscriptionManagedExternally(order.paymentMethod);
    const [nextChargeDate, nextPeriodStart] = getNextChargeDateForUpdateContribution(
      previousNextChargeDate,
      previousNextPeriodStart,
      newInterval,
      prevInterval,
      supportsOffCycle,
    );
    newSubscriptionData['nextChargeDate'] = nextChargeDate.toDate();
    newSubscriptionData['nextPeriodStart'] = nextPeriodStart.toDate();
  }

  // Update order's Tier. The new amount is billed from the next charge, so the tier (and the membership that
  // lists the contributor under it) only changes now if the latest charge already paid for it.
  const previousTierId = order.TierId || null;
  const requestedTierId = tier?.id || null;
  let tierChange: SubscriptionTierChange = 'NONE';
  if (requestedTierId === previousTierId) {
    if (order.data?.pendingTierChange) {
      newData = omit(newData, ['pendingTierChange']);
      tierChange = 'PENDING_CANCELLED';
    }
  } else if (!tier || doesAmountSatisfyTier(tier, order, await getLastPaidAmount(order))) {
    newOrderData['TierId'] = requestedTierId;
    newData = omit(newData, ['pendingTierChange']);
    tierChange = 'APPLIED';
  } else if (order.data?.pendingTierChange?.TierId === tier.id) {
    tierChange = 'PENDING'; // Already pending (e.g. only the amount or tip changed), keep the original request
  } else {
    newData = {
      ...newData,
      pendingTierChange: {
        TierId: tier.id,
        previousTierId,
        requestedAt: new Date().toISOString(),
        requestedByUserId: remoteUser?.id ?? null,
      },
    };
    tierChange = 'PENDING';
  }

  if (
    (!isEmpty(newOrderData) || newData !== order.data) &&
    (newData?.stripePaymentIntent || newData?.needsConfirmation)
  ) {
    newData = omit(newData, ['stripePaymentIntent', 'needsConfirmation']);
  }

  if (newData !== order.data) {
    newOrderData['data'] = newData;
  }

  // Backup previous values
  const result = await updateOrderSubscription(order, newOrderData, newSubscriptionData, {
    onUpdate:
      tierChange === 'APPLIED'
        ? transaction => syncBackerMembershipTier(order, previousTierId, requestedTierId, { transaction })
        : undefined,
  });

  return { ...result, tierChange, previousTierId, requestedTierId };
};
