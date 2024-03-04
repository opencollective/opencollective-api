import config from 'config';
import { pick, toUpper } from 'lodash';
import type Stripe from 'stripe';

import OrderStatuses from '../../constants/order-status';
import logger from '../../lib/logger';
import { getApplicationFee } from '../../lib/payments';
import { reportMessageToSentry } from '../../lib/sentry';
import stripe, { convertToStripeAmount } from '../../lib/stripe';
import { OrderModelInterface } from '../../models/Order';
import { PaymentProviderService } from '../types';

import { APPLICATION_FEE_INCOMPATIBLE_CURRENCIES, refundTransaction, refundTransactionOnlyInDatabase } from './common';

const processOrder = async (order: OrderModelInterface): Promise<void> => {
  const generatedSepaDebit = order.paymentMethod?.data?.generated_sepa_debit;
  if (!generatedSepaDebit) {
    throw new Error(
      'Bancontact cannot be charged off_session if a sepa debit payment method was not generated for it.',
    );
  }

  if (order.currency !== 'EUR') {
    throw new Error('This payment method only accepts EUR payments');
  }

  const hostStripeAccount = await order.collective.getHostStripeAccount();
  const host = await order.collective.getHostCollective();
  const isPlatformRevenueDirectlyCollected =
    host && APPLICATION_FEE_INCOMPATIBLE_CURRENCIES.includes(toUpper(host.currency))
      ? false
      : host?.settings?.isPlatformRevenueDirectlyCollected ?? true;
  const applicationFee = await getApplicationFee(order);

  const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
    customer: order.paymentMethod.customerId,
    currency: order.currency,
    amount: convertToStripeAmount(order.currency, order.totalAmount),
    description: order.description,
    metadata: {
      from: `${config.host.website}/${order.fromCollective.slug}`,
      to: `${config.host.website}/${order.collective.slug}`,
      orderId: order.id,
    },
    // eslint-disable-next-line camelcase
    payment_method: generatedSepaDebit,
    // bancontact is charged as a sepa_debit
    // eslint-disable-next-line camelcase
    payment_method_types: ['sepa_debit'],
  };

  if (applicationFee && isPlatformRevenueDirectlyCollected && hostStripeAccount.username !== config.stripe.accountId) {
    // eslint-disable-next-line camelcase
    paymentIntentParams.application_fee_amount = convertToStripeAmount(order.currency, applicationFee);
  }

  try {
    let paymentIntent = await stripe.paymentIntents.create(paymentIntentParams, {
      stripeAccount: hostStripeAccount.username,
    });

    await order.update({
      data: { ...order.data, paymentIntent: { id: paymentIntent.id, status: paymentIntent.status } },
    });

    paymentIntent = await stripe.paymentIntents.confirm(paymentIntent.id, {
      stripeAccount: hostStripeAccount.username,
    });

    await order.update({
      status: OrderStatuses.PROCESSING,
      data: { ...order.data, paymentIntent },
    });

    if (paymentIntent.status === 'processing') {
      return;
    } else if (paymentIntent.status !== 'succeeded') {
      logger.error('Unknown error with Stripe Payment Intent.');
      reportMessageToSentry('Unknown error with Stripe Payment Intent', { extra: { paymentIntent } });
      throw new Error('Something went wrong with the payment, please contact support@opencollective.com.');
    }
  } catch (e) {
    const sanitizedError = pick(e, ['code', 'message', 'requestId', 'statusCode']);
    const errorMessage = `Error processing Stripe bacs_debit: ${e.message}`;
    logger.error(errorMessage, sanitizedError);
    throw new Error(errorMessage);
  }
};

export default {
  features: {
    recurring: true,
    isRecurringManagedExternally: false,
    waitToCharge: false,
  },
  processOrder,
  refundTransaction,
  refundTransactionOnlyInDatabase,
} as PaymentProviderService;
