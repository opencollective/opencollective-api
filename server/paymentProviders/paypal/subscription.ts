import config from 'config';
import { get, pick } from 'lodash';
import moment from 'moment';

import { SupportedCurrency } from '../../constants/currencies';
import INTERVALS from '../../constants/intervals';
import ORDER_STATUS from '../../constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../constants/paymentMethods';
import TierType from '../../constants/tiers';
import logger from '../../lib/logger';
import { createRefundTransaction } from '../../lib/payments';
import { reportErrorToSentry } from '../../lib/sentry';
import models, { Collective } from '../../models';
import { OrderModelInterface } from '../../models/Order';
import { PaymentMethodModelInterface } from '../../models/PaymentMethod';
import PaypalPlan from '../../models/PaypalPlan';
import Tier from '../../models/Tier';
import { TransactionInterface } from '../../models/Transaction';
import User from '../../models/User';
import { SubscriptionTransactions } from '../../types/paypal';
import { PaymentProviderService } from '../types';

import { paypalRequest } from './api';
import { getCaptureIdFromPaypalTransaction, refundPaypalCapture } from './payment';

export const CANCEL_PAYPAL_EDITED_SUBSCRIPTION_REASON = 'Updated subscription';

export const cancelPaypalSubscription = async (
  order: OrderModelInterface,
  reason = undefined,
  host: Collective = undefined,
): Promise<void> => {
  const collective = order.collective || (await order.getCollective());
  const hostCollective = host || (await collective.getHostCollective());
  const subscription = order.Subscription || (await order.getSubscription());

  try {
    await paypalRequest(
      `billing/subscriptions/${subscription.paypalSubscriptionId}/cancel`,
      { reason },
      hostCollective,
      'POST',
      { shouldReportErrors: false },
    );
  } catch (e) {
    const paypalIssue = get(e, 'metadata.error.details.0.issue');
    if (paypalIssue === 'SUBSCRIPTION_STATUS_INVALID') {
      // Subscription is already cancelled, we can ignore this error
      return;
    }

    logger.error(`PayPal cancel subscription error: ${e.message}`);
    throw e;
  }
};

export const createPaypalPaymentMethodForSubscription = (
  order: OrderModelInterface,
  user: User,
  paypalSubscriptionId: string,
): Promise<PaymentMethodModelInterface> => {
  return models.PaymentMethod.create({
    service: PAYMENT_METHOD_SERVICE.PAYPAL,
    type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
    CreatedByUserId: user.id,
    CollectiveId: order.FromCollectiveId,
    currency: order.currency,
    saved: false,
    token: paypalSubscriptionId,
  });
};

type PaypalProductType = 'DIGITAL' | 'SERVICE';
type PaypalProductCategory = 'MERCHANDISE' | 'MEMBERSHIP_CLUBS_AND_ORGANIZATIONS' | 'NONPROFIT';

/**
 * See https://developer.paypal.com/docs/api/catalog-products/v1/#products-create-response
 */
export const getProductTypeAndCategory = (tier: Tier): [PaypalProductType, PaypalProductCategory?] => {
  switch (tier?.type) {
    case TierType.TICKET:
      return ['DIGITAL'];
    case TierType.PRODUCT:
      return ['DIGITAL', 'MERCHANDISE'];
    case TierType.SERVICE:
      return ['SERVICE'];
    case TierType.MEMBERSHIP:
      return ['DIGITAL', 'MEMBERSHIP_CLUBS_AND_ORGANIZATIONS'];
    default:
      return ['DIGITAL', 'NONPROFIT'];
  }
};

/**
 * PayPal crashes if imageUrl is from http://localhost, which can happen when developing with
 * a local images service.
 */
const getImageUrlForPaypal = collective => {
  if (config.host.images.startsWith('http://localhost')) {
    return 'https://images.opencollective.com/opencollective/logo/256.png';
  } else {
    return collective.getImageUrl();
  }
};

async function createPaypalProduct(host, collective, tier) {
  const [type, category] = getProductTypeAndCategory(tier);

  return paypalRequest(
    `catalogs/products`,
    {
      /* eslint-disable camelcase */
      name: `Financial contribution to ${collective.name}`,
      description: `Financial contribution to ${collective.name}`,
      type,
      category,
      image_url: getImageUrlForPaypal(collective),
      home_url: `https://opencollective.com/${collective.slug}`,
      /* eslint-enable camelcase */
    },
    host,
  );
}

async function createPaypalPlan(host, collective, productId, interval, amount, currency, tier) {
  const description = models.Order.generateDescription(collective, amount, interval, tier);
  return paypalRequest(
    `billing/plans`,
    {
      /* eslint-disable camelcase */
      product_id: productId,
      name: description,
      description: description,
      billing_cycles: [
        {
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0, // This tells PayPal this recurring payment never ends (INFINITE)
          frequency: {
            interval_count: 1,
            interval_unit: interval.toUpperCase(), // month -> MONTH
          },
          pricing_scheme: {
            fixed_price: {
              value: (amount / 100).toString(), // 1667 -> '16.67'
              currency_code: currency,
            },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        payment_failure_threshold: 4, // Will fail up to 4 times, after that the subscription gets cancelled
      },
      /* eslint-enable camelcase */
    },
    host,
  );
}

export async function getOrCreatePlan(
  host: Collective,
  collective: Collective,
  interval: INTERVALS,
  amount: number,
  currency: SupportedCurrency,
  tier: Tier = null,
): Promise<PaypalPlan> {
  const product = await models.PaypalProduct.findOne({
    where: { CollectiveId: collective.id, TierId: tier?.id || null },
    include: [
      {
        association: 'plans',
        required: false,
        where: { currency, interval, amount },
      },
    ],
  });

  if (product) {
    const plans = product['plans'];
    if (plans[0]) {
      // If we found a product and a plan matching these parameters, we can directly return them
      logger.debug(`PayPal: Returning existing plan ${plans[0].id}`);
      return plans[0];
    } else {
      // Otherwise we can create a new plan based on this product
      logger.debug(`PayPal: Re-using existing product ${product.id} and creating new plan`);
      const paypalPlan = await createPaypalPlan(host, collective, product.id, interval, amount, currency, tier);
      return models.PaypalPlan.create({
        id: <string>paypalPlan.id,
        ProductId: product.id,
        amount,
        currency,
        interval,
      });
    }
  } else {
    // If neither the plan or the product exist, we create both in one go
    logger.debug(`PayPal: Creating a new plan`);
    const paypalProduct = await createPaypalProduct(host, collective, tier);
    const paypalPlan = await createPaypalPlan(host, collective, paypalProduct.id, interval, amount, currency, tier);
    return models.PaypalPlan.create(
      {
        id: <string>paypalPlan.id,
        amount,
        currency,
        interval,
        product: {
          id: <string>paypalProduct.id,
          CollectiveId: collective.id,
          TierId: tier?.id,
        },
      },
      {
        // Passing include for Sequelize to understand what `product` is
        include: [{ association: 'product' }],
      },
    );
  }
}

export const setupPaypalSubscriptionForOrder = async (
  order: OrderModelInterface,
  paymentMethod: PaymentMethodModelInterface,
): Promise<OrderModelInterface> => {
  const hostCollective = await order.collective.getHostCollective();
  const existingSubscription = order.SubscriptionId && (await order.getSubscription());
  const paypalSubscriptionId = paymentMethod.token;
  const initialSubscriptionParams = pick(existingSubscription?.dataValues, [
    'isManagedExternally',
    'stripeSubscriptionId',
    'paypalSubscriptionId',
  ]);

  // TODO handle case where a payment arrives on a cancelled subscription
  // TODO refactor payment method to PayPal<>Subscription
  // Prepare the subscription in DB, cancel the existing one if necessary
  try {
    const newPaypalSubscription = await fetchPaypalSubscription(hostCollective, paypalSubscriptionId);
    await verifySubscription(order, newPaypalSubscription);
    await paymentMethod.update({ name: newPaypalSubscription.subscriber['email_address'] });

    if (existingSubscription) {
      // Cancel existing PayPal subscription
      if (existingSubscription.paypalSubscriptionId) {
        await cancelPaypalSubscription(order, CANCEL_PAYPAL_EDITED_SUBSCRIPTION_REASON);
      }

      // Update the subscription with the new params
      await existingSubscription.update({
        isManagedExternally: true,
        stripeSubscriptionId: null,
        paypalSubscriptionId,
      });
    } else {
      await createSubscription(order, paypalSubscriptionId);
    }
  } catch (e) {
    logger.error(`[PayPal] Error while creating subscription: ${e}`);
    reportErrorToSentry(e);

    // Restore the initial subscription
    if (existingSubscription) {
      await existingSubscription.update(initialSubscriptionParams);
    }

    const error = new Error('Failed to configure PayPal subscription');
    error['rootException'] = e;
    throw error;
  }

  // Activate the subscription and update the order
  try {
    await paypalRequest(`billing/subscriptions/${paypalSubscriptionId}/activate`, null, hostCollective, 'POST');
    if (order.PaymentMethodId !== paymentMethod.id) {
      order = await order.update({ PaymentMethodId: paymentMethod.id });
    }
  } catch (e) {
    logger.error(`[PayPal] Error while activating subscription: ${e}`);
    reportErrorToSentry(e);
    const error = new Error('Failed to activate PayPal subscription');
    error['rootException'] = e;
    order.update({ status: ORDER_STATUS.ERROR });
    throw error;
  }

  return order;
};

export const updateSubscriptionWithPaypal = async (
  user: User,
  order: OrderModelInterface,
  paypalSubscriptionId: string,
): Promise<OrderModelInterface> => {
  const paymentMethod = await createPaypalPaymentMethodForSubscription(order, user, paypalSubscriptionId);
  return setupPaypalSubscriptionForOrder(order, paymentMethod);
};

const createSubscription = async (order: OrderModelInterface, paypalSubscriptionId) => {
  return (order as any).createSubscription({
    paypalSubscriptionId,
    amount: order.totalAmount,
    currency: order.currency,
    interval: order.interval,
    quantity: order.quantity,
    isActive: false, // Will be activated when the payment hits
    isManagedExternally: true,
    nextChargeDate: new Date(), // It's supposed to be charged now
    nextPeriodStart: new Date(),
    chargeNumber: 0,
  });
};

export const fetchPaypalSubscription = async (hostCollective, subscriptionId) => {
  return paypalRequest(`billing/subscriptions/${subscriptionId}`, null, hostCollective, 'GET');
};

export const fetchPaypalTransactionsForSubscription = async (
  host,
  subscriptionId,
): Promise<SubscriptionTransactions> => {
  const urlParams = new URLSearchParams();
  urlParams.append('start_time', moment('2020-01-01').toISOString());
  urlParams.append('end_time', moment().toISOString());
  const apiUrl = `billing/subscriptions/${subscriptionId}/transactions?${urlParams.toString()}`;
  return paypalRequest(apiUrl, null, host, 'GET') as Promise<SubscriptionTransactions>;
};

/**
 * Ensures that subscription can be used for this contribution. This is to prevent malicious users
 * from manually creating a subscription that would not match the minimum imposed by a tier.
 */
const verifySubscription = async (order: OrderModelInterface, paypalSubscription) => {
  if (paypalSubscription.status !== 'APPROVED') {
    throw new Error('Subscription must be approved to be activated');
  }

  // If the tier has been deleted, let's make sure we switch to a plan that matches the order
  let tierId = order.TierId;
  if (tierId && !order.Tier) {
    const tier = await models.Tier.findByPk(tierId);
    if (!tier) {
      tierId = null;
    }
  }

  const plan = await models.PaypalPlan.findOne({
    where: { id: paypalSubscription.plan_id },
    include: [
      {
        association: 'product',
        where: { CollectiveId: order.CollectiveId, TierId: tierId },
        required: true,
      },
    ],
  });

  if (!plan) {
    throw new Error(`PayPal plan does not match the subscription (#${paypalSubscription.id})`);
  } else if (plan.amount !== order.totalAmount) {
    throw new Error('The plan amount does not match the order amount');
  }
};

export const isPaypalSubscriptionPaymentMethod = (paymentMethod: PaymentMethodModelInterface): boolean => {
  return (
    paymentMethod?.service === PAYMENT_METHOD_SERVICE.PAYPAL && paymentMethod.type === PAYMENT_METHOD_TYPE.SUBSCRIPTION
  );
};

const PayPalSubscription: PaymentProviderService = {
  features: {
    recurring: true,
    isRecurringManagedExternally: true,
  },

  async processOrder(order: OrderModelInterface): Promise<void> {
    await setupPaypalSubscriptionForOrder(order, order.paymentMethod);
  },

  async refundTransaction(transaction, user, reason) {
    const captureId = getCaptureIdFromPaypalTransaction(transaction);
    if (!captureId) {
      throw new Error(`PayPal Payment capture not found for transaction #${transaction.id}`);
    }

    return refundPaypalCapture(transaction, captureId, user, reason);
  },

  async refundTransactionOnlyInDatabase(
    transaction: TransactionInterface,
    user: User,
    reason: string,
  ): Promise<TransactionInterface> {
    return createRefundTransaction(transaction, 0, { ...transaction.data, refundReason: reason }, user);
  },
};

export default PayPalSubscription;
