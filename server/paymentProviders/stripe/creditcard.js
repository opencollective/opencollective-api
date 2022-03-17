import config from 'config';
import { get, toUpper } from 'lodash';

import * as constants from '../../constants/transactions';
import logger from '../../lib/logger';
import {
  getApplicationFee,
  getHostFee,
  getHostFeeSharePercent,
  getPlatformTip,
  isPlatformTipEligible,
} from '../../lib/payments';
import stripe, { convertFromStripeAmount, convertToStripeAmount, extractFees } from '../../lib/stripe';
import models from '../../models';

import { refundTransaction, refundTransactionOnlyInDatabase } from './common';

const UNKNOWN_ERROR_MSG = 'Something went wrong with the payment, please contact support@opencollective.com.';
const APPLICATION_FEE_INCOMPATIBLE_CURRENCIES = ['BRL'];

/**
 * Get or create a customer under the platform stripe account
 */
const getOrCreateCustomerOnPlatformAccount = async ({ paymentMethod, user, collective }) => {
  if (paymentMethod.customerId) {
    return stripe.customers.retrieve(paymentMethod.customerId);
  }

  const payload = { source: paymentMethod.token };
  if (user) {
    payload.email = user.email;
  }
  if (collective) {
    payload.description = `https://opencollective.com/${collective.slug}`;
  }

  const customer = await stripe.customers.create(payload);

  paymentMethod.customerId = customer.id;
  await paymentMethod.update({ customerId: customer.id });

  return customer;
};

/**
 * Get the customerId for the Stripe Account of the Host
 * Or create one using the Stripe token associated with the platform (paymentMethod.token)
 * and saves it under PaymentMethod.data[hostStripeAccount.username]
 * @param {*} hostStripeAccount
 */
const getOrCreateCustomerOnHostAccount = async (hostStripeAccount, { paymentMethod, user }) => {
  // Customers pre-migration will have their stripe user connected
  // to the platform stripe account, not to the host's stripe
  // account. Since payment methods had no name before that
  // migration, we're using it to test for pre-migration users;

  // Well, DISCARD what is written above, these customers are coming from the Host
  if (!paymentMethod.name) {
    const customer = await stripe.customers.retrieve(paymentMethod.customerId, {
      stripeAccount: hostStripeAccount.username,
    });

    if (customer) {
      logger.info(`Pre-migration customer found: ${paymentMethod.customerId}`);
      logger.info(JSON.stringify(customer));
      return customer;
    }

    logger.info(`Pre-migration customer not found: ${paymentMethod.customerId}`);
    return { id: paymentMethod.customerId };
  }

  const data = paymentMethod.data || {};
  data.customerIdForHost = data.customerIdForHost || {};
  if (data.customerIdForHost[hostStripeAccount.username]) {
    return stripe.customers.retrieve(data.customerIdForHost[hostStripeAccount.username], {
      stripeAccount: hostStripeAccount.username,
    });
  } else {
    const platformStripeCustomer = await getOrCreateCustomerOnPlatformAccount({
      paymentMethod,
      user,
    });

    let customer;

    // This is a special case where the account is the root account
    if (hostStripeAccount.username === config.stripe.accountId) {
      customer = platformStripeCustomer;
    }

    // This is the normal case where we create a customer on the host connected account
    if (!customer) {
      // More info about that
      // - Documentation: https://stripe.com/docs/connect/shared-customers
      // - API: https://stripe.com/docs/api/tokens/create_card
      const token = await stripe.tokens.create(
        { customer: platformStripeCustomer.id },
        { stripeAccount: hostStripeAccount.username },
      );

      customer = await stripe.customers.create(
        { source: token.id, email: user.email },
        { stripeAccount: hostStripeAccount.username },
      );
    }

    data.customerIdForHost[hostStripeAccount.username] = customer.id;
    paymentMethod.data = data;
    await paymentMethod.update({ data });

    return customer;
  }
};

/**
 * Returns a Promise with the transaction created
 * Note: we need to create a token for hostStripeAccount because paymentMethod.customerId is a customer of the platform
 * See: Shared Customers: https://stripe.com/docs/connect/shared-customers
 */
const createChargeAndTransactions = async (hostStripeAccount, { order, hostStripeCustomer }) => {
  const host = await order.collective.getHostCollective();
  const hostFeeSharePercent = await getHostFeeSharePercent(order, host);
  const isSharedRevenue = !!hostFeeSharePercent;
  const isPlatformRevenueDirectlyCollected = !APPLICATION_FEE_INCOMPATIBLE_CURRENCIES.includes(toUpper(order.currency));

  // Compute Application Fee (Shared Revenue + Platform Tip)
  const applicationFee = await getApplicationFee(order, host);

  // Make sure data is available (breaking in some old tests)
  order.data = order.data || {};

  /* eslint-disable camelcase */

  let paymentIntent = order.data.paymentIntent;
  if (!paymentIntent) {
    const createPayload = {
      amount: convertToStripeAmount(order.currency, order.totalAmount),
      currency: order.currency,
      customer: hostStripeCustomer.id,
      description: order.description,
      confirm: false,
      confirmation_method: 'manual',
      metadata: {
        from: `${config.host.website}/${order.fromCollective.slug}`,
        to: `${config.host.website}/${order.collective.slug}`,
      },
    };
    // We don't add a platform fee if the host is the root account
    if (
      applicationFee &&
      isPlatformRevenueDirectlyCollected &&
      hostStripeAccount.username !== config.stripe.accountId
    ) {
      createPayload.application_fee_amount = convertToStripeAmount(order.currency, applicationFee);
    }
    if (order.interval) {
      createPayload.setup_future_usage = 'off_session';
    } else if (!order.processedAt && order.data.savePaymentMethod) {
      createPayload.setup_future_usage = 'on_session';
    }
    // Add Payment Method ID if it's available
    const paymentMethodId = get(hostStripeCustomer, 'default_source', get(hostStripeCustomer, 'sources.data[0].id'));
    if (paymentMethodId) {
      createPayload.payment_method = paymentMethodId;
    } else {
      logger.info('paymentMethod is missing in hostStripeCustomer to pass to Payment Intent.');
      logger.info(JSON.stringify(hostStripeCustomer));
    }
    paymentIntent = await stripe.paymentIntents.create(createPayload, {
      stripeAccount: hostStripeAccount.username,
    });
  }
  paymentIntent = await stripe.paymentIntents.confirm(paymentIntent.id, {
    stripeAccount: hostStripeAccount.username,
  });

  /* eslint-enable camelcase */

  if (paymentIntent.next_action) {
    order.data.paymentIntent = { id: paymentIntent.id, status: paymentIntent.status };
    await order.update({ data: order.data });
    const paymentIntentError = new Error('Payment Intent require action');
    paymentIntentError.stripeAccount = hostStripeAccount.username;
    paymentIntentError.stripeResponse = { paymentIntent };
    throw paymentIntentError;
  }

  if (paymentIntent.status !== 'succeeded') {
    logger.error('Unknown error with Stripe Payment Intent.');
    logger.error(paymentIntent);
    throw new Error(UNKNOWN_ERROR_MSG);
  }

  const charge = paymentIntent.charges.data[0];

  const balanceTransaction = await stripe.balanceTransactions.retrieve(charge.balance_transaction, {
    stripeAccount: hostStripeAccount.username,
  });

  // Create a Transaction
  const amount = order.totalAmount;
  const currency = order.currency;
  const hostCurrency = balanceTransaction.currency.toUpperCase();
  const amountInHostCurrency = convertFromStripeAmount(balanceTransaction.currency, balanceTransaction.amount);
  const hostCurrencyFxRate = amountInHostCurrency / order.totalAmount;

  const hostFee = await getHostFee(order, host);
  const hostFeeInHostCurrency = Math.round(hostFee * hostCurrencyFxRate);

  const fees = extractFees(balanceTransaction, balanceTransaction.currency);

  const platformTipEligible = await isPlatformTipEligible(order, host);
  const platformTip = getPlatformTip(order);

  let platformTipInHostCurrency, platformFeeInHostCurrency;
  if (platformTip) {
    platformTipInHostCurrency = isSharedRevenue
      ? Math.round(platformTip * hostCurrencyFxRate) || 0
      : fees.applicationFee;
  } else if (config.env === 'test' || config.env === 'ci') {
    // Retro Compatibility with some tests expecting Platform Fees, not for production anymore
    // TODO: we need to stop supporting this
    platformFeeInHostCurrency = fees.applicationFee;
  }

  const paymentProcessorFeeInHostCurrency = fees.stripeFee;

  const data = {
    charge,
    balanceTransaction,
    isFeesOnTop: order.data?.isFeesOnTop,
    hasPlatformTip: platformTip ? true : false,
    isSharedRevenue,
    platformTipEligible,
    platformTip,
    platformTipInHostCurrency,
    hostFeeSharePercent,
    settled: true,
    tax: order.data?.tax,
  };

  const transactionPayload = {
    CreatedByUserId: order.CreatedByUserId,
    FromCollectiveId: order.FromCollectiveId,
    CollectiveId: order.CollectiveId,
    PaymentMethodId: order.PaymentMethodId,
    type: constants.TransactionTypes.CREDIT,
    OrderId: order.id,
    amount,
    currency,
    hostCurrency,
    amountInHostCurrency,
    hostCurrencyFxRate,
    paymentProcessorFeeInHostCurrency,
    platformFeeInHostCurrency,
    taxAmount: order.taxAmount,
    description: order.description,
    hostFeeInHostCurrency,
    data,
  };

  return models.Transaction.createFromContributionPayload(transactionPayload, {
    isPlatformRevenueDirectlyCollected,
  });
};

export const setupCreditCard = async (paymentMethod, { user, collective } = {}) => {
  const platformStripeCustomer = await getOrCreateCustomerOnPlatformAccount({
    paymentMethod,
    user,
    collective,
  });

  const paymentMethodId = platformStripeCustomer.sources.data[0].id;

  let setupIntent;
  if (paymentMethod.data.setupIntent) {
    setupIntent = await stripe.setupIntents.retrieve(paymentMethod.data.setupIntent.id);
    // TO CHECK: what happens if the setupIntent is not found
  }
  if (!setupIntent) {
    setupIntent = await stripe.setupIntents.create({
      customer: platformStripeCustomer.id,
      payment_method: paymentMethodId, // eslint-disable-line camelcase
      confirm: true,
    });
  }

  if (
    !paymentMethod.data.setupIntent ||
    paymentMethod.data.setupIntent.id !== setupIntent.id ||
    paymentMethod.data.setupIntent.status !== setupIntent.status
  ) {
    paymentMethod.data.setupIntent = { id: setupIntent.id, status: setupIntent.status };
    await paymentMethod.update({ data: paymentMethod.data });
  }

  if (setupIntent.next_action) {
    const setupIntentError = new Error('Setup Intent require action');
    setupIntentError.stripeResponse = { setupIntent };
    throw setupIntentError;
  }

  return paymentMethod;
};

export default {
  features: {
    recurring: true,
    waitToCharge: false,
  },

  processOrder: async order => {
    const hostStripeAccount = await order.collective.getHostStripeAccount();

    let transactions;
    try {
      const hostStripeCustomer = await getOrCreateCustomerOnHostAccount(hostStripeAccount, {
        paymentMethod: order.paymentMethod,
        user: order.createdByUser,
      });

      transactions = await createChargeAndTransactions(hostStripeAccount, {
        order,
        hostStripeCustomer,
      });
    } catch (error) {
      // Here, we check strictly the error message
      const knownErrors = [
        'Your card has insufficient funds.',
        'Your card was declined.',
        'Your card does not support this type of purchase.',
        'Your card has expired.',
        'Your card is not supported.',
        "Your card's security code is incorrect.",
        "Your card's security code is invalid.",
        'Your card number is incorrect.',
        'The zip code you supplied failed validation.',
        'Invalid amount.',
        'Payment Intent require action',
        'Invalid account.',
      ];

      if (knownErrors.includes(error.message)) {
        logger.error(
          `Stripe Error (handled): ${error.type}, Message: ${error.message}, Decline Code: ${error.decline_code}, Code: ${error.code}`,
        );
        throw error;
      }

      // Here, we do a partial check and rewrite the error.
      const identifiedErrors = {
        // This object cannot be accessed right now because another API request or Stripe process is currently accessing it.
        // If you see this error intermittently, retry the request.
        // If you see this error frequently and are making multiple concurrent requests to a single object, make your requests serially or at a lower rate.
        'This object cannot be accessed right now because another API request or Stripe process is currently accessing it.':
          'Payment Processing error (API request).',
        // You cannot confirm this PaymentIntent because it's missing a payment method.
        // To confirm the PaymentIntent with cus_9cNHqpdWYOV4aH, specify a payment method attached to this customer along with the customer ID.
        "You cannot confirm this PaymentIntent because it's missing a payment method.":
          'Internal Payment error (invalid PaymentIntent)',
        // You have exceeded the maximum number of declines on this card in the last 24 hour period.
        // Please contact us via https://support.stripe.com/contact if you need further assistance.
        'You have exceeded the maximum number of declines on this card': 'Your card was declined.',
        // An error occurred while processing your card. Try again in a little bit.
        'An error occurred while processing your card.': 'Payment Processing error (API error).',
        // This account cannot currently make live charges.
        // If you are a customer trying to make a purchase, please contact the owner of this site.
        // Your transaction has not been processed.
        'This account cannot currently make live charges.': 'Payment Processing error (Host error).',
      };
      const errorKey = Object.keys(identifiedErrors).find(errorMessage => error.message.includes(errorMessage));
      if (errorKey) {
        throw new Error(identifiedErrors[errorKey]);
      }

      logger.error(`Unknown Stripe Payment Error: ${error.message}`);
      logger.error(error);
      logger.error(error.stack);

      throw new Error(UNKNOWN_ERROR_MSG);
    }

    await order.paymentMethod.update({
      confirmedAt: new Date(),
      saved: order.paymentMethod.saved || Boolean(order.data?.savePaymentMethod),
    });

    return transactions;
  },

  refundTransaction,
  refundTransactionOnlyInDatabase,
  webhook: (/* requestBody, event */) => {
    // We don't do anything at the moment
    return Promise.resolve();
  },
};
