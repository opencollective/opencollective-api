import config from 'config';
import { get } from 'lodash';
import moment from 'moment';
import Stripe from 'stripe';

import { ZERO_DECIMAL_CURRENCIES } from '../constants/currencies';
import { VirtualCardLimitIntervals } from '../constants/virtual-cards';

const stripe = new Stripe(config.stripe.secret, { apiVersion: undefined, maxNetworkRetries: 2 });

export default stripe;

export const StripeCustomToken = token => {
  const stripe = new Stripe(token, { apiVersion: undefined, maxNetworkRetries: 2 });
  return stripe;
};

export const extractFees = (balance, currency) => {
  const fees = {
    total: convertFromStripeAmount(currency, balance.fee),
    stripeFee: 0,
    applicationFee: 0,
    other: 0,
  };

  balance.fee_details.forEach(fee => {
    if (fee.type === 'stripe_fee') {
      fees.stripeFee += convertFromStripeAmount(currency, fee.amount);
    } else if (fee.type === 'application_fee') {
      fees.applicationFee += convertFromStripeAmount(currency, fee.amount);
    } else {
      fees.other += convertFromStripeAmount(currency, fee.amount);
    }
  });
  return fees;
};

/**
 * Returns true if token is a valid stripe test token.
 * See https://stripe.com/docs/testing#cards
 */
export const isTestToken = token => {
  return [
    'tok_bypassPending',
    'tok_chargeDeclined',
    'tok_chargeDeclinedExpiredCard',
    'tok_chargeDeclinedProcessingError',
  ].includes(token);
};

/**
 * Handles the zero-decimal currencies for Stripe; https://stripe.com/docs/currencies#zero-decimal
 */
export const convertToStripeAmount = (currency, amount) => {
  if (ZERO_DECIMAL_CURRENCIES.includes(currency?.toUpperCase())) {
    return Math.floor(amount / 100);
  } else {
    return amount;
  }
};

export const convertFromStripeAmount = (currency, amount) => {
  if (ZERO_DECIMAL_CURRENCIES.includes(currency?.toUpperCase())) {
    return amount * 100;
  } else {
    return amount;
  }
};

export const retrieveChargeWithRefund = async (chargeId, stripeAccount) => {
  const charge = await stripe.charges.retrieve(chargeId, {
    stripeAccount: stripeAccount.username,
  });
  if (!charge) {
    throw Error(`charge id ${chargeId} not found`);
  }

  const refundId = get(charge, 'refunds.data[0].id');
  const refund = refundId
    ? await stripe.refunds.retrieve(refundId, {
        stripeAccount: stripeAccount.username,
      })
    : null;

  const disputeId = get(charge, 'dispute.id');
  const dispute = disputeId
    ? await stripe.disputes.retrieve(disputeId, {
        stripeAccount: stripeAccount.username,
      })
    : null;

  return { charge, refund, dispute };
};

export const getSpendingLimitIntervalDates = (spendingLimitInterval: VirtualCardLimitIntervals) => {
  const now = moment().utc(true);

  // Stripe spending limit intervals start on UTC midnight for daily, Sunday at midnight UTC for weekly and 1st of the month or year
  // https://stripe.com/docs/api/issuing/cards/object#issuing_card_object-spending_controls-spending_limits-interval
  switch (spendingLimitInterval) {
    case VirtualCardLimitIntervals.DAILY:
      return {
        renewedOn: now.startOf('day').toISOString(),
        renewsOn: now.add(1, 'day').startOf('day').toISOString(),
      };
    case VirtualCardLimitIntervals.WEEKLY:
      return {
        renewedOn: now.startOf('isoWeek').toISOString(),
        renewsOn: now.add(1, 'week').startOf('isoWeek').toISOString(),
      };
    case VirtualCardLimitIntervals.MONTHLY:
      return {
        renewedOn: now.startOf('month').toISOString(),
        renewsOn: now.add(1, 'month').startOf('month').toISOString(),
      };
    case VirtualCardLimitIntervals.YEARLY:
      return {
        renewedOn: now.startOf('year').toISOString(),
        renewsOn: now.add(1, 'year').startOf('year').toISOString(),
      };
    case VirtualCardLimitIntervals.ALL_TIME:
    case VirtualCardLimitIntervals.PER_AUTHORIZATION:
    default:
      return {};
  }
};
