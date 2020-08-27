import { isNumber, pick } from 'lodash';

import { maxInteger } from '../../constants/math';
import { HOST_FEE_PERCENT, TransactionTypes } from '../../constants/transactions';
import { createRefundTransaction } from '../../lib/payments';
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
  const payload = pick(order, ['CreatedByUserId', 'FromCollectiveId', 'CollectiveId', 'PaymentMethodId']);
  const host = await order.collective.getHostCollective();

  if (host.currency !== order.currency) {
    throw Error(
      `Cannot manually record a transaction in a different currency than the currency of the host ${host.currency}`,
    );
  }

  // Pick the first that is set as a Number
  const platformFeePercent = [
    // Fixed in the Order (special tiers: BackYourStack, Pre-Paid)
    order.data?.platformFeePercent,
    // Fixed for Bank Transfers at collective level
    order.collective.data?.bankTransfersPlatformFeePercent,
    // Fixed for Bank Transfers at host level
    // As of August 2020, this will be only set on a selection of Hosts (opensource 5%)
    host.data?.bankTransfersPlatformFeePercent,
    // Default for Collective (skipped for now)
    // order.collective.platformFeePercent,
    // Default to 0
    0,
  ].find(isNumber);

  // Pick the first that is set as a Number
  const hostFeePercent = [
    // Fixed in the Order (special tiers: BackYourStack, Pre-Paid)
    order.data?.hostFeePercent,
    // Fixed for Bank Transfers at collective level
    // As of August 2020, this will be only set on a selection of Collective (some foundation collectives 5%)
    order.collective.data?.bankTransfersHostFeePercent,
    // Fixed for Bank Transfers at host level
    // As of August 2020, this will be only set on a selection of Hosts (foundation 8%)
    host.data?.bankTransfersHostFeePercent,
    // Default for Collective
    order.collective.hostFeePercent,
    // Just in case, default on the platform
    HOST_FEE_PERCENT,
  ].find(isNumber);

  const isFeesOnTop = order.data?.isFeesOnTop || false;
  const feeOnTop = order.data?.platformFee || 0;

  let platformFeeInHostCurrency;
  if (isFeesOnTop) {
    // If it's "Fees On Top", we're just using that
    platformFeeInHostCurrency = feeOnTop;
  } else {
    //  Otherwise, use platformFeePercent
    platformFeeInHostCurrency = -Math.round((platformFeePercent / 100) * order.totalAmount);
  }

  const hostFeeInHostCurrency = -Math.round((hostFeePercent / 100) * (order.totalAmount - feeOnTop));

  const paymentProcessorFeeInHostCurrency = 0;

  payload.transaction = {
    type: TransactionTypes.CREDIT,
    OrderId: order.id,
    amount: order.totalAmount,
    currency: order.currency,
    hostCurrency: host.currency,
    hostCurrencyFxRate: 1,
    netAmountInCollectiveCurrency: order.totalAmount - hostFeeInHostCurrency - platformFeeInHostCurrency,
    amountInHostCurrency: order.totalAmount,
    hostFeeInHostCurrency,
    platformFeeInHostCurrency,
    paymentProcessorFeeInHostCurrency,
    taxAmount: order.taxAmount,
    description: order.description,
    data: {
      isFeesOnTop: order.data?.isFeesOnTop,
    },
  };

  const creditTransaction = await models.Transaction.createFromPayload(payload);
  return creditTransaction;
}

/**
 * Refund a given transaction by creating the opposing transaction.
 * There's nothing more to do because it's up to the host/collective to see how
 * they want to actually refund the money.
 */
const refundTransaction = async (transaction, user) => {
  return await createRefundTransaction(transaction, 0, null, user);
};

/* Expected API of a Payment Method Type */
export default {
  features: {
    recurring: false,
    waitToCharge: true, // don't process the order automatically. Wait for host to "mark it as paid"
  },
  getBalance,
  processOrder,
  refundTransaction,
};
