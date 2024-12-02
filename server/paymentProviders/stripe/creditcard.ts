import config from 'config';
import { omit, toUpper } from 'lodash';
import type Stripe from 'stripe';

import logger from '../../lib/logger';
import { getApplicationFee } from '../../lib/payments';
import { reportErrorToSentry, reportMessageToSentry } from '../../lib/sentry';
import stripe, { convertToStripeAmount } from '../../lib/stripe';
import { Collective } from '../../models';
import Order from '../../models/Order';
import PaymentMethod from '../../models/PaymentMethod';
import User from '../../models/User';
import { PaymentProviderServiceWithInternalRecurringManagement } from '../types';

import {
  APPLICATION_FEE_INCOMPATIBLE_CURRENCIES,
  attachCardToPlatformCustomer,
  createChargeTransactions,
  refundTransaction,
  refundTransactionOnlyInDatabase,
  resolvePaymentMethodForOrder,
  UNKNOWN_ERROR_MSG,
  userFriendlyErrorMessage,
} from './common';

/**
 * Returns a Promise with the transaction created
 * Creates and confirms a payment intent, on success creates associated transactions
 */
const createChargeAndTransactions = async (
  hostStripeAccount,
  { order, stripePaymentMethod }: { order: Order; stripePaymentMethod: { id: string; customer: string } },
) => {
  const host = await order.collective.getHostCollective();
  const isPlatformRevenueDirectlyCollected =
    host && APPLICATION_FEE_INCOMPATIBLE_CURRENCIES.includes(toUpper(host.currency))
      ? false
      : (host?.settings?.isPlatformRevenueDirectlyCollected ?? true);

  // Compute Application Fee (Shared Revenue + Platform Tip)
  const applicationFee = await getApplicationFee(order);

  // Make sure data is available (breaking in some old tests)
  order.data = order.data || {};

  /* eslint-disable camelcase */

  let paymentIntent: Stripe.PaymentIntent | undefined = order.data.paymentIntent;
  if (!paymentIntent || paymentIntent.status === 'succeeded') {
    const createPayload: Stripe.PaymentIntentCreateParams = {
      amount: convertToStripeAmount(order.currency, order.totalAmount),
      currency: order.currency,
      customer: stripePaymentMethod.customer,
      description: order.description,
      confirm: false,
      confirmation_method: 'manual',
      metadata: {
        from: `${config.host.website}/${order.fromCollective.slug}`,
        to: `${config.host.website}/${order.collective.slug}`,
        orderId: order.id,
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

    const stripePaymentMethodId = stripePaymentMethod.id;
    if (stripePaymentMethodId) {
      createPayload.payment_method = stripePaymentMethodId;
    } else {
      logger.info('paymentMethod is missing in paymentMethod to pass to Payment Intent.');
      logger.info(JSON.stringify(stripePaymentMethod));
    }
    paymentIntent = await stripe.paymentIntents.create(createPayload, {
      stripeAccount: hostStripeAccount.username,
    });
  }

  paymentIntent = await stripe.paymentIntents.confirm(
    paymentIntent.id,
    { payment_method: stripePaymentMethod.id, expand: ['latest_charge'] },
    { stripeAccount: hostStripeAccount.username },
  );

  /* eslint-enable camelcase */

  if (paymentIntent.next_action) {
    await order.update({ data: { ...order.data, paymentIntent } }); // Store the payment intent to make sure it will be re-used after the 3D secure confirmation
    const paymentIntentError = new Error('Payment Intent require action');
    paymentIntentError['stripeAccount'] = hostStripeAccount.username;
    paymentIntentError['stripeResponse'] = { paymentIntent };
    throw paymentIntentError;
  }

  if (paymentIntent.status !== 'succeeded') {
    logger.error('Unknown error with Stripe Payment Intent.');
    logger.error(paymentIntent);
    reportMessageToSentry('Unknown error with Stripe Payment Intent', { extra: { paymentIntent } });
    throw new Error(UNKNOWN_ERROR_MSG);
  }

  await order.update({
    data: {
      ...omit(order.data, 'paymentIntent'),
      previousPaymentIntents: [...(order.data.previousPaymentIntents ?? []), paymentIntent],
    },
  });

  const charge = paymentIntent.latest_charge || (paymentIntent as any).charges.data[0];
  return createChargeTransactions(charge as Stripe.Charge, { order });
};

export const setupCreditCard = async (
  paymentMethod: PaymentMethod,
  { user, collective }: { user?: User; collective?: Collective } = {},
) => {
  paymentMethod = await attachCardToPlatformCustomer(paymentMethod, collective, user);

  let setupIntent;
  if (paymentMethod.data.setupIntent) {
    setupIntent = await stripe.setupIntents.retrieve(paymentMethod.data.setupIntent.id);
    // TO CHECK: what happens if the setupIntent is not found
  }
  if (!setupIntent) {
    setupIntent = await stripe.setupIntents.create({
      customer: paymentMethod.customerId,
      payment_method: paymentMethod.data?.stripePaymentMethodId, // eslint-disable-line camelcase
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
    setupIntentError['stripeResponse'] = { setupIntent };
    throw setupIntentError;
  }

  return paymentMethod;
};

export default {
  features: {
    recurring: true,
    isRecurringManagedExternally: false,
    waitToCharge: false,
  },

  processOrder: async order => {
    const hostStripeAccount = await order.collective.getHostStripeAccount();

    let transactions;
    try {
      const stripePaymentMethod = await resolvePaymentMethodForOrder(hostStripeAccount.username, order);
      transactions = await createChargeAndTransactions(hostStripeAccount, {
        order,
        stripePaymentMethod,
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

      const userFriendlyError = userFriendlyErrorMessage(error);
      if (userFriendlyError) {
        throw new Error(userFriendlyError);
      }

      logger.error(`Unknown Stripe Payment Error: ${error.message}`);
      logger.error(error);
      logger.error(error.stack);
      reportErrorToSentry(error);

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
} as PaymentProviderServiceWithInternalRecurringManagement;
