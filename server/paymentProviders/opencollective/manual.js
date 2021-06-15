import { pick } from 'lodash';

import { maxInteger } from '../../constants/math';
import { TransactionTypes } from '../../constants/transactions';
import { FEATURE, hasOptedInForFeature } from '../../lib/allowed-features';
import { getFxRate } from '../../lib/currency';
import { createRefundTransaction, getHostFee, getPlatformFee } from '../../lib/payments';
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
  const hostPlan = await host.getPlan();
  const hostFeeSharePercent = hostPlan?.hostFeeSharePercent;
  const isSharedRevenue = !!hostFeeSharePercent;

  if (host.currency !== order.currency && !hasOptedInForFeature(host, FEATURE.CROSS_CURRENCY_MANUAL_TRANSACTIONS)) {
    throw Error(
      `Cannot manually record a transaction in a different currency than the currency of the host ${host.currency}`,
    );
  }

  // In some tests, we don't have an order.paymentMethod set ...
  if (!order.paymentMethod) {
    order.paymentMethod = { service: 'opencollective', type: 'manual' };
  }

  const hostCurrency = host.currency;
  const hostCurrencyFxRate = await getFxRate(order.currency, hostCurrency);
  const amountInHostCurrency = Math.round(order.totalAmount * hostCurrencyFxRate);

  const platformFeeInHostCurrency = await getPlatformFee(amountInHostCurrency, order, host);
  const hostFeeInHostCurrency = await getHostFee(amountInHostCurrency, order, host);

  const isFeesOnTop = order.data?.isFeesOnTop || false;

  const paymentProcessorFeeInHostCurrency = order.data?.paymentProcessorFeeInHostCurrency || 0;

  const transactionPayload = {
    ...pick(order, ['CreatedByUserId', 'FromCollectiveId', 'CollectiveId', 'PaymentMethodId']),
    type: TransactionTypes.CREDIT,
    OrderId: order.id,
    amount: order.totalAmount,
    currency: order.currency,
    hostCurrency,
    hostCurrencyFxRate,
    amountInHostCurrency,
    hostFeeInHostCurrency,
    platformFeeInHostCurrency,
    paymentProcessorFeeInHostCurrency,
    taxAmount: order.taxAmount,
    description: order.description,
    data: {
      isFeesOnTop,
      isSharedRevenue,
      hostFeeSharePercent,
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
