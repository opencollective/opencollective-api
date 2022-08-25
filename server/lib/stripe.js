import config from 'config';
import { get } from 'lodash';
import Stripe from 'stripe';

import { ZERO_DECIMAL_CURRENCIES } from '../constants/currencies';

const stripe = Stripe(config.stripe.secret);

// Retry a request twice before giving up
stripe.setMaxNetworkRetries(2);

export default stripe;

export const StripeCustomToken = token => {
  const stripe = Stripe(token);
  stripe.setMaxNetworkRetries(2);
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

  console.log(charge);

  // if (charge.disputed) {
  //   console.log('Charge is already disputed.');
  //   return;
  // }
  // if (charge.refunded) {
  //   console.log('Charge is already refunded.');
  //   return;
  // }

  const refundId = get(charge, 'refunds.data[0].id');
  const refund = refundId
    ? await stripe.refunds.retrieve(refundId, {
        stripeAccount: stripeAccount.username,
      })
    : null;

  return { charge, refund };
};
