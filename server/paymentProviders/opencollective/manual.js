import { pick } from 'lodash';

import { maxInteger } from '../../constants/math';
import { TransactionTypes } from '../../constants/transactions';
import { getFxRate, roundCentsAmount } from '../../lib/currency';
import {
  createRefundTransaction,
  getHostFee,
  getHostFeeSharePercent,
  getPlatformTip,
  isPlatformTipEligible,
} from '../../lib/payments';
import models from '../../models';

/**
 * Manual Payment method
 * This payment method enables a host to manually receive donations (e.g. by wire directly to the host's bank account)
 * The order's status will be set to PENDING and will have to be updated manually by the host
 */

/** Get the balance
 * Since we don't have a way to check the balance of the donor, we return Infinity
 * note: since GraphQL doesn't like Infinity, we use maxInteger
 */
async function getBalance() {
  return maxInteger;
}

/** Process an order with a manual payment method
 *
 * @param {models.Order} order The order instance to be processed.
 * @return {models.Transaction} the double entry generated transactions.
 */
async function processOrder(order) {
  // gets the Credit transaction generated
  const host = await order.collective.getHostCollective();

  // In some tests, we don't have an order.paymentMethod set ...
  if (!order.paymentMethod) {
    order.paymentMethod = { service: 'opencollective', type: 'manual' };
  }

  const hostFeeSharePercent = await getHostFeeSharePercent(order);
  const isSharedRevenue = !!hostFeeSharePercent;

  const amount = order.totalAmount;
  const currency = order.currency;
  const hostCurrency = host.currency;
  const hostCurrencyFxRate = await getFxRate(order.currency, hostCurrency);
  const amountInHostCurrency = roundCentsAmount(order.totalAmount * hostCurrencyFxRate, hostCurrency);

  const hostFee = await getHostFee(order);
  const hostFeeInHostCurrency = roundCentsAmount(hostFee * hostCurrencyFxRate, hostCurrency);

  const platformTipEligible = await isPlatformTipEligible(order);
  const platformTip = getPlatformTip(order);
  const platformTipInHostCurrency = roundCentsAmount(platformTip * hostCurrencyFxRate, hostCurrency);

  const paymentProcessorFee = order.data?.paymentProcessorFee || 0;
  const paymentProcessorFeeInHostCurrency =
    order.data?.paymentProcessorFeeInHostCurrency ||
    roundCentsAmount(paymentProcessorFee * hostCurrencyFxRate, hostCurrency) ||
    0;

  const transactionPayload = {
    ...pick(order, ['CreatedByUserId', 'FromCollectiveId', 'CollectiveId', 'PaymentMethodId']),
    type: TransactionTypes.CREDIT,
    OrderId: order.id,
    amount,
    currency,
    hostCurrency,
    hostCurrencyFxRate,
    amountInHostCurrency,
    hostFeeInHostCurrency,
    taxAmount: order.taxAmount,
    description: order.description,
    paymentProcessorFeeInHostCurrency,
    clearedAt: order.processedAt || null,
    data: {
      hasPlatformTip: platformTip ? true : false,
      isSharedRevenue,
      platformTipEligible,
      platformTip,
      platformTipInHostCurrency,
      hostFeeSharePercent,
      tax: order.data?.tax,
    },
  };

  const creditTransaction = await models.Transaction.createFromContributionPayload(transactionPayload);

  return creditTransaction;
}

/**
 * Refund a given transaction by creating the opposing transaction.
 * There's nothing more to do because it's up to the host/collective to see how
 * they want to actually refund the money.
 */
const refundTransaction = async (transaction, user, reason, refundKind) => {
  return createRefundTransaction(
    transaction,
    0,
    { ...transaction.data, refundReason: reason },
    user,
    null,
    null,
    refundKind,
  );
};

/* Expected API of a Payment Method Type */
export default {
  features: {
    recurring: false,
    isRecurringManagedExternally: false,
    waitToCharge: true, // don't process the order automatically. Wait for host to "mark it as paid"
  },
  getBalance,
  processOrder,
  refundTransaction,
};
