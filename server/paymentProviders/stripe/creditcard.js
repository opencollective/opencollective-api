import config from 'config';
import { get, toUpper } from 'lodash';
import { v4 as uuid } from 'uuid';

import FEATURE from '../../constants/feature';
import OrderStatuses from '../../constants/order_status';
import { PAYMENT_METHOD_TYPE } from '../../constants/paymentMethods';
import { TransactionKind } from '../../constants/transaction-kind';
import { getFxRate } from '../../lib/currency';
import logger from '../../lib/logger';
import { toNegative } from '../../lib/math';
import { createRefundTransaction, getApplicationFee } from '../../lib/payments';
import { reportErrorToSentry, reportMessageToSentry } from '../../lib/sentry';
import stripe, { convertToStripeAmount } from '../../lib/stripe';
import models from '../../models';

import {
  APPLICATION_FEE_INCOMPATIBLE_CURRENCIES,
  createChargeTransactions,
  refundTransaction,
  refundTransactionOnlyInDatabase,
} from './common';

const UNKNOWN_ERROR_MSG = 'Something went wrong with the payment, please contact support@opencollective.com.';

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
  const isPlatformRevenueDirectlyCollected = APPLICATION_FEE_INCOMPATIBLE_CURRENCIES.includes(toUpper(host.currency))
    ? false
    : host?.settings?.isPlatformRevenueDirectlyCollected ?? true;

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
    reportMessageToSentry('Unknown error with Stripe Payment Intent', { extra: { paymentIntent } });
    throw new Error(UNKNOWN_ERROR_MSG);
  }

  const charge = paymentIntent.charges.data[0];
  return createChargeTransactions(charge, { order });
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

// Charge has a new Stripe dispute
async function createDispute(event) {
  const stripeChargeId = event.data.object.charge;
  const chargeTransaction = await models.Transaction.findOne({
    where: { data: { charge: { id: stripeChargeId } } },
    include: [
      {
        model: models.User,
        required: true,
        as: 'createdByUser',
      },
    ],
  });

  if (!chargeTransaction) {
    return;
  }

  const user = chargeTransaction.createdByUser;

  const transactions = await models.Transaction.findAll({
    where: {
      TransactionGroup: chargeTransaction.TransactionGroup,
    },
    include: {
      model: models.Order,
      required: true,
      include: [models.Subscription],
    },
  });

  // Block User from creating any new Orders
  await user.limitFeature(FEATURE.ORDER);

  await Promise.all(
    transactions.map(async transaction => {
      await transaction.update({ isDisputed: true });
      const order = transaction.Order;
      if (order.status !== OrderStatuses.DISPUTED) {
        await order.update({ status: OrderStatuses.DISPUTED });

        if (order.SubscriptionId) {
          await order.Subscription.deactivate();
        }
      }
    }),
  );
}

// Charge dispute has been closed on Stripe (with status of: won/lost/closed)
async function closeDispute(event) {
  const stripeChargeId = event.data.object.charge;
  const chargeTransaction = await models.Transaction.findOne({
    where: { data: { charge: { id: stripeChargeId } }, isDisputed: true },
    include: [
      {
        model: models.Order,
        required: true,
        include: [models.Subscription],
      },
      {
        model: models.User,
        required: true,
        as: 'createdByUser',
      },
    ],
  });

  if (!chargeTransaction) {
    return;
  }

  const user = chargeTransaction.createdByUser;

  const transactions = await models.Transaction.findAll({
    where: {
      TransactionGroup: chargeTransaction.TransactionGroup,
    },
    include: {
      model: models.Order,
      required: true,
      include: [models.Subscription],
    },
  });

  if (transactions.length > 0) {
    const order = chargeTransaction.Order;

    const disputeStatus = event.data.object.status;
    const disputeTransaction = event.data.object.balance_transactions.find(
      tx => tx.type === 'adjustment' && tx.reporting_category === 'dispute',
    );

    // A lost dispute means it was decided as fraudulent
    if (disputeStatus === 'lost') {
      if (order.status === OrderStatuses.DISPUTED) {
        if (order.SubscriptionId) {
          await order.update({ status: OrderStatuses.CANCELLED });
        } else {
          await order.update({ status: OrderStatuses.REFUNDED });
        }
      }

      const paymentMethod = await order.getPaymentMethod();
      if (paymentMethod?.type === PAYMENT_METHOD_TYPE.CREDITCARD) {
        await models.SuspendedAsset.suspendCreditCard(paymentMethod, `CreditCard was disputed in order ${order.id}`);
      }

      // Create refund transaction for the fraudulent charge
      const transactionGroup = uuid();
      await createRefundTransaction(
        chargeTransaction,
        0,
        {
          ...chargeTransaction.data,
          dispute: event,
          refundTransactionId: chargeTransaction.id,
        },
        null,
        transactionGroup,
      );

      // Create transaction for dispute fee debiting the fiscal host
      const feeDetails = disputeTransaction.fee_details.find(feeDetails => feeDetails.description === 'Dispute fee');
      const currency = feeDetails.currency.toUpperCase();
      const amount = feeDetails.amount;
      const fiscalHost = await models.Collective.findByPk(chargeTransaction.HostCollectiveId);
      const hostCurrencyFxRate = await getFxRate(currency, fiscalHost.currency);
      const hostCurrencyAmount = Math.round(toNegative(amount) * hostCurrencyFxRate);

      await models.Transaction.create({
        type: 'DEBIT',
        HostCollectiveId: fiscalHost.id,
        CollectiveId: fiscalHost.id,
        FromCollectiveId: fiscalHost.id,
        OrderId: chargeTransaction.OrderId,
        TransactionGroup: transactionGroup,
        amount: toNegative(amount),
        netAmountInCollectiveCurrency: toNegative(amount),
        amountInHostCurrency: hostCurrencyAmount,
        currency: currency,
        hostCurrency: fiscalHost.currency,
        description: 'Stripe Transaction Dispute Fee',
        paymentProcessorFeeInHostCurrency: 0,
        hostFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        hostCurrencyFxRate,
        kind: TransactionKind.PAYMENT_PROCESSOR_DISPUTE_FEE,
        data: event.data,
      });

      // A won dispute means it was decided as not fraudulent
    } else if (disputeStatus === 'won') {
      if (order.status === OrderStatuses.DISPUTED) {
        if (order.SubscriptionId) {
          await order.update({ status: OrderStatuses.ACTIVE });
          await order.Subscription.activate();
        } else {
          await order.update({ status: OrderStatuses.PAID });
        }
      }

      const userHasDisputedOrders = await user.hasDisputedOrders();
      if (!userHasDisputedOrders) {
        await user.unlimitFeature(FEATURE.ORDER);
      }

      await Promise.all(
        transactions.map(async transaction => {
          await transaction.update({ isDisputed: false });
        }),
      );
    }
  }
}

// Charge on Stripe had a fraud review opened
async function openReview(event) {
  const stripePaymentIntentId = event.data.object.payment_intent;
  const paymentIntentTransaction = await models.Transaction.findOne({
    // eslint-disable-next-line camelcase
    where: { data: { charge: { payment_intent: stripePaymentIntentId } } },
    include: [
      {
        model: models.Order,
        required: true,
        include: [models.Subscription],
      },
    ],
  });

  if (!paymentIntentTransaction) {
    return;
  }

  const transactions = await models.Transaction.findAll({
    where: {
      TransactionGroup: paymentIntentTransaction.TransactionGroup,
    },
    include: {
      model: models.Order,
      required: true,
      include: [models.Subscription],
    },
  });

  await Promise.all(
    transactions.map(async transaction => {
      await transaction.update({ isInReview: true });
      const order = transaction.Order;
      if (order.status !== OrderStatuses.IN_REVIEW) {
        await order.update({ status: OrderStatuses.IN_REVIEW });

        if (order.SubscriptionId) {
          await order.Subscription.deactivate();
        }
      }
    }),
  );
}

// Charge on Stripe had a fraud review closed (either approved/refunded)
async function closeReview(event) {
  const stripePaymentIntentId = event.data.object.payment_intent;
  const closedReason = event.data.object.closed_reason;

  const paymentIntentTransaction = await models.Transaction.findOne({
    // eslint-disable-next-line camelcase
    where: { data: { charge: { payment_intent: stripePaymentIntentId } } },
    include: [
      {
        model: models.Order,
        required: true,
        include: [models.Subscription],
      },
      {
        model: models.User,
        required: true,
        as: 'createdByUser',
      },
    ],
  });

  if (!paymentIntentTransaction) {
    return;
  }

  const user = paymentIntentTransaction.createdByUser;

  const transactions = await models.Transaction.findAll({
    where: {
      TransactionGroup: paymentIntentTransaction.TransactionGroup,
    },
    include: {
      model: models.Order,
      required: true,
      include: [models.Subscription],
    },
  });

  if (transactions.length > 0) {
    const order = paymentIntentTransaction.Order;

    // closedReasons: approved, refunded, refunded_as_fraud, disputed, redacted
    if (closedReason === 'refunded_as_fraud' || closedReason === 'refunded') {
      if (order.status === OrderStatuses.IN_REVIEW) {
        if (order.SubscriptionId) {
          await order.update({ status: OrderStatuses.CANCELLED });
        } else {
          await order.update({ status: OrderStatuses.REFUNDED });
        }
      }

      // Create refund transaction for the fraudulent charge
      const transactionGroup = uuid();
      await createRefundTransaction(
        paymentIntentTransaction,
        0,
        {
          ...paymentIntentTransaction.data,
          review: event,
          refundTransactionId: paymentIntentTransaction.id,
        },
        null,
        transactionGroup,
      );

      // charge review was determined to be fraudulent
      if (closedReason === 'refunded_as_fraud') {
        await user.limitFeature(FEATURE.ORDER);
      } else if (closedReason === 'refunded') {
        await Promise.all(
          transactions.map(async transaction => {
            await transaction.update({ isInReview: false });
          }),
        );
      }
    } else {
      if (order.status === OrderStatuses.IN_REVIEW) {
        if (order.SubscriptionId) {
          await order.update({ status: OrderStatuses.ACTIVE });
          await order.Subscription.activate();
        } else {
          await order.update({ status: OrderStatuses.PAID });
        }
      }

      await Promise.all(
        transactions.map(async transaction => {
          await transaction.update({ isInReview: false });
        }),
      );
    }
  }
}

export default {
  features: {
    recurring: true,
    waitToCharge: false,
  },
  closeDispute,
  createDispute,
  openReview,
  closeReview,

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
        // This is a new unhandled error. We think customers should delete the card and add it again.
        // eslint-disable-next-line camelcase
        card_error_authentication_required:
          'There is an issue with your card, please contact support@opencollective.com.',
      };
      const errorKey = Object.keys(identifiedErrors).find(errorMessage => error.message.includes(errorMessage));
      if (errorKey) {
        throw new Error(identifiedErrors[errorKey]);
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
};
