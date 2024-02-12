import { get, isUndefined, omit, pickBy, truncate } from 'lodash';

import FEATURE from '../../constants/feature';
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
import { reportErrorToSentry } from '../../lib/sentry';
import { formatCurrency } from '../../lib/utils';
import models from '../../models';
import { OrderModelInterface } from '../../models/Order';
import { TransactionInterface } from '../../models/Transaction';
import User from '../../models/User';
import { PaypalCapture, PaypalSale, PaypalTransaction } from '../../types/paypal';

import { paypalRequestV2 } from './api';

/** Create transaction in our database to reflect a PayPal charge */
const recordTransaction = async (
  order,
  amount,
  currency,
  paypalFee,
  { data = undefined, createdAt = undefined, clearedAt = undefined } = {},
): Promise<TransactionInterface> => {
  order.collective = order.collective || (await order.getCollective());
  const host = await order.collective.getHostCollective();
  if (!host) {
    throw new Error(`Cannot create transaction: collective id ${order.collective.id} doesn't have a host`);
  }
  const hostCurrency = host.currency;
  const hostFeeSharePercent = await getHostFeeSharePercent(order, { host });
  const isSharedRevenue = !!hostFeeSharePercent;

  const hostCurrencyFxRate = await getFxRate(currency, hostCurrency);
  const amountInHostCurrency = Math.round(amount * hostCurrencyFxRate);
  const paymentProcessorFeeInHostCurrency = Math.round(hostCurrencyFxRate * paypalFee);

  const hostFee = await getHostFee(order, { host });
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
    createdAt: createdAt || null,
    clearedAt: clearedAt || null,
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

  return models.Transaction.createFromContributionPayload(transactionData);
};

// Unfortunately, PayPal has 3 different transaction types: sale, capture and transaction. Though they all
// represent the same thing (IDs point toward the same thing), the data structure is different. We thus need
// these 3 functions to handle them all.

export function recordPaypalSale(order: OrderModelInterface, paypalSale: PaypalSale): Promise<TransactionInterface> {
  const currency = paypalSale.amount.currency;
  const amount = paypalAmountToCents(paypalSale.amount.total);
  const fee = paypalAmountToCents(get(paypalSale, 'transaction_fee.value', '0.0'));
  return recordTransaction(order, amount, currency, fee, {
    data: { paypalSale, paypalCaptureId: paypalSale.id },
    clearedAt: paypalSale.create_time && new Date(paypalSale.create_time),
  });
}

export function recordPaypalTransaction(
  order: OrderModelInterface,
  paypalTransaction: PaypalTransaction,
  { data = undefined, createdAt = undefined } = {},
): Promise<TransactionInterface> {
  const currency = paypalTransaction.amount_with_breakdown.gross_amount.currency_code;
  const amount = floatAmountToCents(parseFloat(paypalTransaction.amount_with_breakdown.gross_amount.value));
  const fee = parseFloat(get(paypalTransaction.amount_with_breakdown, 'fee_amount.value', '0.0'));
  return recordTransaction(order, amount, currency, fee, {
    data: { ...data, paypalTransaction, paypalCaptureId: paypalTransaction.id },
    createdAt,
    clearedAt: paypalTransaction.time && new Date(paypalTransaction.time),
  });
}

export const recordPaypalCapture = async (
  order: OrderModelInterface,
  capture: PaypalCapture,
  { data = undefined, createdAt = undefined } = {},
): Promise<TransactionInterface> => {
  const currency = capture.amount.currency_code;
  const amount = paypalAmountToCents(capture.amount.value);
  const fee = paypalAmountToCents(get(capture, 'seller_receivable_breakdown.paypal_fee.value', '0.0'));

  return recordTransaction(order, amount, currency, fee, {
    data: { ...data, capture, paypalCaptureId: capture.id },
    createdAt,
    clearedAt: capture.create_time && new Date(capture.create_time),
  });
};

/**
 * Returns the PayPal transaction associated to this ID, if any.
 * `HostCollectiveId`/`OrderId` are optional but make the query way more performant.
 */
export async function findTransactionByPaypalId(
  paypalTransactionId: string,
  { type = 'CREDIT', HostCollectiveId = undefined, OrderId = undefined } = {},
) {
  return models.Transaction.findOne({
    where: {
      ...pickBy({ type, HostCollectiveId, OrderId }, value => !isUndefined(value)),
      data: { paypalCaptureId: paypalTransactionId },
    },
  });
}

const processPaypalOrder = async (order, paypalOrderId): Promise<TransactionInterface | undefined> => {
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

  // Confirm the authorization
  const authorizeResult = await paypalRequestV2(`${paypalOrderUrl}/authorize`, hostCollective, 'POST');
  const authorizationId = authorizeResult.purchase_units[0].payments.authorizations[0].id;

  // Trigger the capture
  const captureParams = {};
  captureParams['final_capture'] = true;
  captureParams['invoice_id'] = `Contribution #${order.id}`;
  const triggerCaptureURL = `payments/authorizations/${authorizationId}/capture`;
  const captureResult = await paypalRequestV2(triggerCaptureURL, hostCollective, 'POST', captureParams);
  const captureId = captureResult.id as string;
  await order.update({ data: { ...order.data, paypalCaptureId: captureId } }); // Store immediately in the order to keep track of it in case anything goes wrong with the next queries

  if (captureResult.status !== 'COMPLETED') {
    // Return nothing, the transactions will be created by the webhook when the charge switches to COMPLETED
    return;
  }

  // Record successfully captured transaction
  const captureUrl = `payments/captures/${captureId}`;
  const captureDetails = (await paypalRequestV2(captureUrl, hostCollective, 'GET')) as PaypalCapture;

  // Prevent double-records in case the webhook event gets processed before the API replies
  let transaction;
  await order.lock(
    async () => {
      transaction = await models.Transaction.findOne({
        where: {
          OrderId: order.id,
          type: 'CREDIT',
          kind: 'CONTRIBUTION',
          data: { capture: { id: captureId } },
        },
      });

      if (!transaction) {
        transaction = await recordPaypalCapture(order, captureDetails);
      }
    },
    {
      // Retry for 10 seconds
      retryDelay: 500,
      retries: 20,
    },
  );

  return transaction;
};

export const refundPaypalCapture = async (
  transaction: TransactionInterface,
  captureId: string,
  user: User,
  reason: string,
): Promise<TransactionInterface> => {
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
    reportErrorToSentry(error, {
      feature: FEATURE.PAYPAL_DONATIONS,
      user: user,
      extra: { transactionId: transaction.id, captureId, reason },
    });

    const newData = omit(transaction.data, ['isRefundedFromOurSystem']);
    await transaction.update({ data: newData });
    throw error;
  }
};

const refundTransactionOnlyInDatabase = async (
  transaction: TransactionInterface,
  user: User,
  reason: string,
): Promise<TransactionInterface> => {
  return createRefundTransaction(transaction, 0, { ...transaction.data, refundReason: reason }, user);
};

/** Process order in paypal and create transactions in our db */
export async function processOrder(order: OrderModelInterface): Promise<TransactionInterface | undefined> {
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
  transaction: TransactionInterface,
  user: User,
  reason: string,
): Promise<TransactionInterface> => {
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
  refundTransactionOnlyInDatabase,
};
