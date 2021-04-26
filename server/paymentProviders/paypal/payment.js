import { get, isNumber, truncate } from 'lodash';

import * as constants from '../../constants/transactions';
import { getFxRate } from '../../lib/currency';
import logger from '../../lib/logger';
import { floatAmountToCents } from '../../lib/math';
import { createRefundTransaction, getHostFee, getPlatformFee } from '../../lib/payments';
import { paypalAmountToCents } from '../../lib/paypal';
import { formatCurrency } from '../../lib/utils';
import models from '../../models';

import { paypalRequest, paypalRequestV2 } from './api';

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

const processPaypalOrder = async (order, paypalOrderId) => {
  const hostCollective = await order.collective.getHostCollective();
  const paypalOrderUrl = `checkout/orders/${paypalOrderId}`;

  // Check payment details
  const paypalOrderDetails = await paypalRequestV2(paypalOrderUrl, hostCollective, 'GET');
  const purchaseUnit = paypalOrderDetails['purchase_units'][0];
  const paypalAmountInCents = floatAmountToCents(parseFloat(purchaseUnit.amount['value']));
  const paypalCurrency = purchaseUnit.amount['currency_code'];
  if (paypalAmountInCents !== order.totalAmount || paypalCurrency !== order.currency) {
    const expected = formatCurrency(order.totalAmount, order.currency);
    const actual = formatCurrency(paypalAmountInCents, paypalCurrency);
    throw new Error(
      `The amount/currency for this payment doesn't match what's expected for this order (expected: ${expected}, actual: ${actual})`,
    );
  } else if (paypalOrderDetails.status === 'COMPLETED') {
    throw new Error('This PayPal order has already been charged');
  }

  // Trigger the actual charge
  const capture = await paypalRequestV2(`${paypalOrderUrl}/capture`, hostCollective, 'POST');
  const captureId = capture.purchase_units[0].payments.captures[0].id;
  const captureDetails = await paypalRequestV2(`payments/captures/${captureId}`, hostCollective, 'GET');

  // Record the charge in our ledger
  return recordPaypalCapture(order, captureDetails);
};

export const refundPaypalCapture = async (transaction, captureId, user, reason) => {
  const host = await transaction.getHostCollective();
  if (!host) {
    throw new Error(`PayPal: Can't find host for transaction #${transaction.id}`);
  }

  // eslint-disable-next-line camelcase
  const payload = { note_to_payer: truncate(reason, { length: 255 }) || undefined };
  const result = await paypalRequestV2(`payments/captures/${captureId}/refund`, host, 'POST', payload);
  const rawRefundedPaypalFee = get(result, 'seller_payable_breakdown.paypal_fee.amount.value', '0.00');
  const refundedPaypalFee = floatAmountToCents(parseFloat(rawRefundedPaypalFee));
  return createRefundTransaction(transaction, refundedPaypalFee, { paypalResponse: result }, user);
};

/** Process order in paypal and create transactions in our db */
export async function processOrder(order) {
  if (order.paymentMethod.data?.isNewApi) {
    if (order.paymentMethod.data.orderId) {
      return processPaypalOrder(order, order.paymentMethod.data.orderId);
    } else {
      throw new Error('Must provide an orderId');
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

const getCaptureIdFromPaypalTransaction = transaction => {
  const { data } = transaction;
  if (!data) {
    return null;
  } else if (data.intent === 'sale') {
    return get(data, 'transactions.0.related_resources.0.sale.id');
  } else {
    return data.capture?.id || data.paypalSale?.id || data.paypalTransaction?.id;
  }
};

const refundPaypalPaymentTransaction = async (transaction, user, reason) => {
  const captureId = getCaptureIdFromPaypalTransaction(transaction);
  if (!captureId) {
    throw new Error(`PayPal Payment capture not found for transaction #${transaction.id}`);
  }

  return refundPaypalCapture(transaction, captureId, user, reason);
};

/* Interface expected for a payment method */
export default {
  features: { recurring: false },
  processOrder,
  refundTransaction: refundPaypalPaymentTransaction,
};
