import config from 'config';
import { get, isNumber } from 'lodash';
import fetch from 'node-fetch';

import TierType from '../../constants/tiers';
import * as constants from '../../constants/transactions';
import { getFxRate } from '../../lib/currency';
import logger from '../../lib/logger';
import { floatAmountToCents } from '../../lib/math';
import { getHostFee, getPlatformFee } from '../../lib/payments';
import { paypalAmountToCents } from '../../lib/paypal';
import models from '../../models';

/** Build an URL for the PayPal API */
export function paypalUrl(path, version = 'v1') {
  if (path.startsWith('/')) {
    throw new Error("Please don't use absolute paths");
  }
  const baseUrl =
    config.paypal.payment.environment === 'sandbox'
      ? `https://api.sandbox.paypal.com/${version}/`
      : `https://api.paypal.com/${version}/`;
  return new URL(baseUrl + path).toString();
}

/** Exchange clientid and secretid by an auth token with PayPal API */
export async function retrieveOAuthToken({ clientId, clientSecret }) {
  const url = paypalUrl('oauth2/token');
  const body = 'grant_type=client_credentials';
  /* The OAuth token entrypoint uses Basic HTTP Auth */
  const authStr = `${clientId}:${clientSecret}`;
  const basicAuth = Buffer.from(authStr).toString('base64');
  const headers = { Authorization: `Basic ${basicAuth}` };
  /* Execute the request and unpack the token */
  const response = await fetch(url, { method: 'post', body, headers });
  const jsonOutput = await response.json();
  return jsonOutput.access_token;
}

/** Assemble POST requests for communicating with PayPal API */
export async function paypalRequest(urlPath, body, hostCollective, method = 'POST') {
  const connectedPaypalAccounts = await hostCollective.getConnectedAccounts({
    where: { service: 'paypal', deletedAt: null },
    order: [['createdAt', 'DESC']],
  });
  const paypal = connectedPaypalAccounts[0];
  if (!paypal || !paypal.clientId || !paypal.token) {
    throw new Error("Host doesn't support PayPal payments.");
  }
  const url = paypalUrl(urlPath);
  const token = await retrieveOAuthToken({ clientId: paypal.clientId, clientSecret: paypal.token });

  const params = {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  const result = await fetch(url, params);
  if (!result.ok) {
    let errorData = null;
    let errorMessage = 'PayPal payment rejected';
    try {
      errorData = await result.json();
      errorMessage = `${errorMessage}: ${errorData.message}`;
    } catch (e) {
      errorData = e;
    }
    logger.error('PayPal payment failed', result, errorData);
    throw new Error(errorMessage);
  } else if (result.status === 204) {
    return null;
  } else {
    return result.json();
  }
}

export async function paypalRequestV2(hostCollective, urlPath, method = 'POST') {
  const connectedPaypalAccounts = await hostCollective.getConnectedAccounts({
    where: { service: 'paypal' },
    order: [['createdAt', 'DESC']],
  });
  const paypal = connectedPaypalAccounts[0];
  if (!paypal || !paypal.clientId || !paypal.token) {
    throw new Error("Host doesn't support PayPal payments.");
  }

  const url = paypalUrl(urlPath, 'v2');
  const token = await retrieveOAuthToken({ clientId: paypal.clientId, clientSecret: paypal.token });
  const params = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  const result = await fetch(url, params);
  if (!result.ok) {
    let errorData = null;
    let errorMessage = 'PayPal payment rejected';
    try {
      errorData = await result.json();
      errorMessage = `${errorMessage}: ${errorData.message}`;
    } catch (e) {
      errorData = e;
    }
    logger.error('PayPal payment failed', result, errorData);
    throw new Error(errorMessage);
  }
  return result.json();
}

/** Create a new payment object in the PayPal API
 *
 * It's just a wrapper to the PayPal API method `create-payment':
 * https://developer.paypal.com/docs/integration/direct/express-checkout/integration-jsv4/advanced-payments-api/create-express-checkout-payments/
 */
export async function createPayment(req, res) {
  const { amount, currency, hostId } = req.body;
  if (!amount || !currency) {
    throw new Error('Amount & Currency are required');
  }
  const hostCollective = await models.Collective.findByPk(hostId);
  if (!hostCollective) {
    throw new Error("Couldn't find host collective");
  }
  /* eslint-disable camelcase */
  const paymentParams = {
    intent: 'sale',
    payer: { payment_method: 'paypal' },
    transactions: [{ amount: { total: amount, currency } }],
    /* The values bellow are required by the PayPal API but they're
       not really used so they were just filled in with something
       reasonable. */
    redirect_urls: {
      return_url: 'https://opencollective.com',
      cancel_url: 'https://opencollective.com',
    },
  };
  /* eslint-enable camelcase */
  const payment = await paypalRequest('payments/payment', paymentParams, hostCollective);
  return res.json({ id: payment.id });
}

/**
 * See https://developer.paypal.com/docs/api/catalog-products/v1/#products-create-response
 */
export const getProductTypeAndCategory = tier => {
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

export async function getOrCreatePlan(host, collective, interval, amount, currency, tier = null) {
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
        id: paypalPlan.id,
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
        amount,
        currency,
        interval,
        id: paypalPlan.id,
        product: {
          id: paypalProduct.id,
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

/** Execute an already created payment
 *
 * It's just a wrapper to the PayPal API method `execute-payment':
 * https://developer.paypal.com/docs/integration/direct/express-checkout/execute-payments/
 */
export async function executePayment(order) {
  const hostCollective = await order.collective.getHostCollective();
  const { paymentID, payerID } = order.paymentMethod.data;
  return paypalRequest(
    `payments/payment/${paymentID}/execute`,
    {
      payer_id: payerID, // eslint-disable-line camelcase
    },
    hostCollective,
  );
}

/** Create transaction in our database to reflect a PayPal charge */
const recordTransaction = async (order, amount, currency, paypalFee, payload) => {
  const host = await order.collective.getHostCollective();
  if (!host) {
    throw new Error(`Cannot create transaction: collective id ${order.collective.id} doesn't have a host`);
  }
  const hostCurrency = host.currency;
  const hostPlan = await host.getPlan();
  const hostFeeSharePercent = isNumber(hostPlan?.paypalHostFeeSharePercent)
    ? hostPlan?.paypalHostFeeSharePercent
    : hostPlan?.hostFeeSharePercent;
  const isSharedRevenue = !!hostFeeSharePercent;
  const platformTip = order.data?.platformFee;

  const hostCurrencyFxRate = await getFxRate(currency, hostCurrency);
  const amountInHostCurrency = Math.round(hostCurrencyFxRate * amount);
  const paymentProcessorFeeInHostCurrency = Math.round(hostCurrencyFxRate * paypalFee);
  const hostFeeInHostCurrency = await getHostFee(amountInHostCurrency, order);
  const platformFeeInHostCurrency = isSharedRevenue
    ? platformTip || 0
    : await getPlatformFee(amountInHostCurrency, order, host, { hostFeeSharePercent });

  return models.Transaction.createFromPayload({
    CreatedByUserId: order.CreatedByUserId,
    FromCollectiveId: order.FromCollectiveId,
    CollectiveId: order.CollectiveId,
    PaymentMethodId: order.PaymentMethodId,
    transaction: {
      type: constants.TransactionTypes.CREDIT,
      OrderId: order.id,
      amount,
      currency,
      amountInHostCurrency,
      hostCurrency,
      hostCurrencyFxRate,
      hostFeeInHostCurrency,
      platformFeeInHostCurrency,
      paymentProcessorFeeInHostCurrency,
      taxAmount: order.taxAmount,
      description: order.description,
      data: {
        ...payload,
        isFeesOnTop: order.data?.isFeesOnTop,
        platformTip: order.data?.platformFee,
        isSharedRevenue,
        hostFeeSharePercent,
      },
    },
  });
};

export async function createTransaction(order, paymentInfo) {
  const transaction = paymentInfo.transactions[0];
  const currency = transaction.amount.currency;
  const amount = paypalAmountToCents(transaction.amount.total);
  const paypalTransactionFee = parseFloat(get(transaction, 'related_resources.0.sale.transaction_fee.value', '0.0'));
  const paymentProcessorFee = floatAmountToCents(paypalTransactionFee);
  return recordTransaction(order, amount, currency, paymentProcessorFee, paymentInfo);
}

export function recordPaypalSale(order, paypalSale) {
  const currency = paypalSale.amount.currency;
  const amount = paypalAmountToCents(paypalSale.amount.total);
  const fee = paypalAmountToCents(get(paypalSale, 'transaction_fee.value', '0.0'));
  return recordTransaction(order, amount, currency, fee, { paypalSale });
}

export function recordPaypalTransaction(order, paypalTransaction) {
  const currency = paypalTransaction.amount_with_breakdown.gross_amount.currency_code;
  const amount = floatAmountToCents(parseFloat(paypalTransaction.amount_with_breakdown.gross_amount.value));
  const fee = parseFloat(get(paypalTransaction.amount_with_breakdown, 'fee_amount.value', '0.0'));
  return recordTransaction(order, amount, currency, fee, { paypalTransaction });
}

const recordPaypalCapture = async (order, capture) => {
  const currency = capture.amount.currency;
  const amount = paypalAmountToCents(capture.amount.value);
  const fee = paypalAmountToCents(get(capture, 'seller_receivable_breakdown.paypal_fee.value', '0.0'));
  return recordTransaction(order, amount, currency, fee, { capture });
};

export const cancelPaypalSubscription = async (subscriptionId, reason = undefined) => {
  await paypalRequest(`billing/subscriptions/${subscriptionId}/cancel`, { reason });
};

/** Process order in paypal and create transactions in our db */
export async function processOrder(order) {
  const hostCollective = await order.collective.getHostCollective();
  if (order.paymentMethod.data.isNewApi) {
    if (order.paymentMethod.data.orderId) {
      const orderId = order.paymentMethod.data.orderId;
      const capture = await paypalRequestV2(hostCollective, `checkout/orders/${orderId}/capture`, 'POST');
      const captureId = capture.purchase_units[0].payments.captures[0].id;
      const captureDetails = await paypalRequestV2(hostCollective, `payments/captures/${captureId}`, 'GET');
      return recordPaypalCapture(order, captureDetails);
    } else if (order.paymentMethod.data.subscriptionId) {
      const subscriptionId = order.paymentMethod.data.subscriptionId;
      await paypalRequest(`billing/subscriptions/${subscriptionId}/activate`, null, hostCollective, 'POST');
      await order.update({ data: { ...order.data, paypalSubscriptionId: subscriptionId, skipPendingEmail: true } });
      // Don't record the transaction here (will be done in the webhook event)
    } else {
      throw new Error('Must either provide a subscriptionId or an orderId');
    }
  } else {
    const paymentInfo = await executePayment(order);
    logger.info('PayPal Payment');
    logger.info(paymentInfo);
    const transaction = await createTransaction(order, paymentInfo);
    await order.update({ processedAt: new Date() });
    await order.paymentMethod.update({ confirmedAt: new Date() });
    return transaction;
  }
}

/* Interface expected for a payment method */
export default {
  features: {
    recurring: true,
  },
  processOrder,
};
