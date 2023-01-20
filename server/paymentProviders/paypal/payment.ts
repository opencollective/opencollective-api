import { get, isUndefined, pickBy, truncate } from 'lodash';

import * as constants from '../../constants/transactions';
import { getFxRate } from '../../lib/currency';
import { floatAmountToCents } from '../../lib/math';
import {
  createRefundTransaction,
  getHostFee,
  getHostFeeSharePercent,
  getPlatformTip,
  isPlatformTipEligible,
} from '../../lib/payments';
import { paypalAmountToCents } from '../../lib/paypal';
import { formatCurrency } from '../../lib/utils';
import models, { Op } from '../../models';
import User from '../../models/User';

import { paypalRequestV2 } from './api';

/** Create transaction in our database to reflect a PayPal charge */
const recordTransaction = async (
  order,
  amount,
  currency,
  paypalFee,
  { data = undefined, createdAt = undefined } = {},
): Promise<typeof models.Transaction> => {
  order.collective = order.collective || (await order.getCollective());
  const host = await order.collective.getHostCollective();
  if (!host) {
    throw new Error(`Cannot create transaction: collective id ${order.collective.id} doesn't have a host`);
  }
  const hostCurrency = host.currency;
  const hostFeeSharePercent = await getHostFeeSharePercent(order, host);
  const isSharedRevenue = !!hostFeeSharePercent;

  const hostCurrencyFxRate = await getFxRate(currency, hostCurrency);
  const amountInHostCurrency = Math.round(amount * hostCurrencyFxRate);
  const paymentProcessorFeeInHostCurrency = Math.round(hostCurrencyFxRate * paypalFee);

  const hostFee = await getHostFee(order, host);
  const hostFeeInHostCurrency = Math.round(hostFee * hostCurrencyFxRate);

  const platformTipEligible = await isPlatformTipEligible(order, host);
  const platformTip = getPlatformTip(order);
  const platformTipInHostCurrency = Math.round(platformTip * hostCurrencyFxRate);

  const transactionData = {
    CreatedByUserId: order.CreatedByUserId,
    FromCollectiveId: order.FromCollectiveId,
    CollectiveId: order.CollectiveId,
    PaymentMethodId: order.PaymentMethodId,
    type: constants.TransactionTypes.CREDIT,
    OrderId: order.id,
    amount,
    currency,
    amountInHostCurrency,
    hostCurrency,
    hostCurrencyFxRate,
    hostFeeInHostCurrency,
    paymentProcessorFeeInHostCurrency,
    taxAmount: order.taxAmount,
    description: order.description,
    data: {
      ...data,
      hasPlatformTip: platformTip ? true : false,
      isSharedRevenue,
      platformTipEligible,
      platformTip,
      platformTipInHostCurrency,
      hostFeeSharePercent,
      tax: order.data?.tax,
    },
  };

  if (createdAt) {
    transactionData['createdAt'] = createdAt;
  }

  return models.Transaction.createFromContributionPayload(transactionData);
};

export function recordPaypalSale(order: typeof models.Order, paypalSale): Promise<typeof models.Transaction> {
  const currency = paypalSale.amount.currency;
  const amount = paypalAmountToCents(paypalSale.amount.total);
  const fee = paypalAmountToCents(get(paypalSale, 'transaction_fee.value', '0.0'));
  return recordTransaction(order, amount, currency, fee, { data: { paypalSale } });
}

export function recordPaypalTransaction(
  order: typeof models.Order,
  paypalTransaction,
  { data = undefined, createdAt = undefined } = {},
): Promise<typeof models.Transaction> {
  const currency = paypalTransaction.amount_with_breakdown.gross_amount.currency_code;
  const amount = floatAmountToCents(parseFloat(paypalTransaction.amount_with_breakdown.gross_amount.value));
  const fee = parseFloat(get(paypalTransaction.amount_with_breakdown, 'fee_amount.value', '0.0'));
  return recordTransaction(order, amount, currency, fee, { data: { ...data, paypalTransaction }, createdAt });
}

export const recordPaypalCapture = async (
  order: typeof models.Order,
  capture,
  { data = undefined, createdAt = undefined } = {},
): Promise<typeof models.Transaction> => {
  const currency = capture.amount.currency_code;
  const amount = paypalAmountToCents(capture.amount.value);
  const fee = paypalAmountToCents(get(capture, 'seller_receivable_breakdown.paypal_fee.value', '0.0'));
  return recordTransaction(order, amount, currency, fee, { data: { ...data, capture }, createdAt });
};

/**
 * Returns the PayPal transaction associated to this ID, if any.
 * `HostCollectiveId`/`OrderId` are optional but make the query way more performant.
 */
export async function findTransactionByPaypalId(
  paypalTransactionId: string,
  { type = 'CREDIT', HostCollectiveId = undefined, OrderId = undefined, searchSaleIdOnly = false } = {},
) {
  const dataQuery = {};
  const include = [];
  if (searchSaleIdOnly) {
    dataQuery['paypalSale'] = { id: paypalTransactionId };
    include.push({ model: models.PaymentMethod, where: { service: 'paypal' } });
  } else {
    dataQuery[Op.or] = [
      { capture: { id: paypalTransactionId } },
      { paypalSale: { id: paypalTransactionId } },
      { paypalTransaction: { id: paypalTransactionId } },
    ];
  }

  return models.Transaction.findOne({
    where: {
      ...pickBy({ type, HostCollectiveId, OrderId }, value => !isUndefined(value)),
      data: dataQuery,
    },
  });
}

const processPaypalOrder = async (order, paypalOrderId): Promise<typeof models.Transaction | undefined> => {
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
  await order.update({ data: { ...order.data, paypalCaptureId: captureId } });
  const captureDetails = await paypalRequestV2(`payments/captures/${captureId}`, hostCollective, 'GET');
  if (captureDetails.status !== 'COMPLETED') {
    // Return nothing, the transactions will be created by the webhook when the charge switches to COMPLETED
    return;
  }

  // Prevent double-records in the (quite unlikely) case where the webhook event would be processed before the API replies
  const existingTransaction = await models.Transaction.findOne({
    where: {
      OrderId: order.id,
      type: 'CREDIT',
      kind: 'CONTRIBUTION',
      data: { capture: { id: capture.id } },
    },
  });

  if (existingTransaction) {
    return existingTransaction;
  } else {
    return recordPaypalCapture(order, captureDetails);
  }
};

export const refundPaypalCapture = async (
  transaction: typeof models.Transaction,
  captureId: string,
  user: User,
  reason: string,
): Promise<typeof models.Transaction> => {
  const host = await transaction.getHostCollective();
  if (!host) {
    throw new Error(`PayPal: Can't find host for transaction #${transaction.id}`);
  }

  // Add a flag on transaction to make sure the `PAYMENT.CAPTURE.REFUNDED` webhook event will be ignored
  // since we're already doing everything here
  await transaction.update({ data: { ...transaction.data, isRefundedFromOurSystem: true } });
  try {
    // eslint-disable-next-line camelcase
    const payload = { note_to_payer: truncate(reason, { length: 255 }) || undefined };
    const result = await paypalRequestV2(`payments/captures/${captureId}/refund`, host, 'POST', payload);
    const refundDetails = await paypalRequestV2(`payments/refunds/${result.id}`, host, 'GET');
    const rawRefundedPaypalFee = <string>get(refundDetails, 'seller_payable_breakdown.paypal_fee.value', '0.00');
    const refundedPaypalFee = floatAmountToCents(parseFloat(rawRefundedPaypalFee));
    return createRefundTransaction(
      transaction,
      refundedPaypalFee,
      { refundReason: reason, paypalResponse: result },
      user,
    );
  } catch (error) {
    const newData = delete transaction.data.isRefundedFromOurSystem;
    await transaction.update({ data: newData });
    throw error;
  }
};

/** Process order in paypal and create transactions in our db */
export async function processOrder(order: typeof models.Order): Promise<typeof models.Transaction | undefined> {
  if (order.paymentMethod.data.orderId) {
    return processPaypalOrder(order, order.paymentMethod.data.orderId);
  } else {
    throw new Error('Must provide an orderId');
  }
}

export const getCaptureIdFromPaypalTransaction = transaction => {
  const { data } = transaction;
  if (!data) {
    return null;
  } else if (data.intent === 'sale') {
    return get(data, 'transactions.0.related_resources.0.sale.id');
  } else {
    return data.capture?.id || data.paypalSale?.id || data.paypalTransaction?.id;
  }
};

const refundPaypalPaymentTransaction = async (
  transaction: typeof models.Transaction,
  user: User,
  reason: string,
): Promise<typeof models.Transaction> => {
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
