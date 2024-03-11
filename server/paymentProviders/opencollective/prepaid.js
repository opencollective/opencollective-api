import { get } from 'lodash';

import { TransactionTypes } from '../../constants/transactions';
import { getFxRate } from '../../lib/currency';
import {
  createRefundTransaction,
  getHostFee,
  getHostFeeSharePercent,
  getPlatformTip,
  isPlatformTipEligible,
  isProvider,
} from '../../lib/payments';
import models, { Op } from '../../models';

/** Get the balance of a prepaid credit card
 *
 * When a card is created by a host (by adding funds to an
 * organization for example) the card is created with an initial
 * balance. This function subtracts the amount from transactions made
 * with this card from the initial balance.
 *
 * @param {models.PaymentMethod} paymentMethod is the instance of the
 *  prepaid credit card payment method.
 * @return {Object} with amount & currency from the payment method.
 */
async function getBalance(paymentMethod) {
  if (!isProvider('opencollective.prepaid', paymentMethod)) {
    throw new Error(`Expected opencollective.prepaid but got ${paymentMethod.service}.${paymentMethod.type}`);
  }
  /* Result will be negative (We're looking for DEBIT transactions) */
  const allTransactions = await models.Transaction.findAll({
    attributes: ['netAmountInCollectiveCurrency', 'currency'],
    where: { type: 'DEBIT', RefundTransactionId: null },
    include: [
      {
        model: models.PaymentMethod,
        required: true,
        attributes: [],
        where: {
          [Op.or]: {
            id: paymentMethod.id,
            SourcePaymentMethodId: paymentMethod.id,
          },
        },
      },
    ],
  });
  let spent = 0;
  for (const transaction of allTransactions) {
    if (transaction.currency !== paymentMethod.currency) {
      const fxRate = await getFxRate(transaction.currency, paymentMethod.currency);
      spent += transaction.netAmountInCollectiveCurrency * fxRate;
    } else {
      spent += transaction.netAmountInCollectiveCurrency;
    }
  }
  return {
    amount: Math.round(paymentMethod.initialBalance + spent),
    currency: paymentMethod.currency,
  };
}

/** Process a pre paid card order
 *
 * @param {models.Order} order The order instance to be processed.
 * @return {models.Transaction} As any other payment method, after
 *  processing Giftcard orders, the transaction generated from it is
 *  returned.
 */
async function processOrder(order) {
  const user = order.createdByUser;
  const {
    paymentMethod: { data },
  } = order;
  // Making sure the paymentMethod has the information we need to
  // process a prepaid card
  if (!get(data, 'HostCollectiveId')) {
    throw new Error('Prepaid payment method must have a value for `data.HostCollectiveId`');
  }

  // Check that target Collective's Host is same as gift card issuer
  const host = await order.collective.getHostCollective();
  if (host.id !== data.HostCollectiveId) {
    throw new Error('Prepaid method can only be used in collectives from the same host');
  }

  // Checking if balance is ok or will still be after completing the order
  const balance = await getBalance(order.paymentMethod);
  if (balance.amount - order.totalAmount < 0) {
    throw new Error("This payment method doesn't have enough funds to complete this order");
  }

  const hostFeeSharePercent = await getHostFeeSharePercent(order);
  const isSharedRevenue = !!hostFeeSharePercent;

  const amount = order.totalAmount;
  const currency = order.currency;
  const hostCurrency = host.currency;
  const hostCurrencyFxRate = await getFxRate(currency, hostCurrency);
  const amountInHostCurrency = Math.round(amount * hostCurrencyFxRate);

  const platformTipEligible = await isPlatformTipEligible(order);
  const platformTip = getPlatformTip(order);
  const platformTipInHostCurrency = Math.round(platformTip * hostCurrencyFxRate);

  const hostFee = await getHostFee(order);
  const hostFeeInHostCurrency = Math.round(hostFee * hostCurrencyFxRate);

  // Use the above payment method to donate to Collective
  const transactions = await models.Transaction.createFromContributionPayload({
    CreatedByUserId: user.id,
    FromCollectiveId: order.FromCollectiveId,
    CollectiveId: order.CollectiveId,
    PaymentMethodId: order.paymentMethod.id,
    type: TransactionTypes.CREDIT,
    OrderId: order.id,
    amount,
    amountInHostCurrency,
    currency,
    hostCurrency,
    hostCurrencyFxRate,
    hostFeeInHostCurrency,
    paymentProcessorFeeInHostCurrency: 0,
    taxAmount: order.taxAmount,
    description: order.description,
    data: {
      hasPlatformTip: platformTip ? true : false,
      isSharedRevenue,
      platformTipEligible,
      platformTip,
      platformTipInHostCurrency,
      hostFeeSharePercent,
      tax: order.data?.tax,
    },
  });

  // Mark paymentMethod as confirmed
  order.paymentMethod.update({ confirmedAt: new Date() });

  return transactions;
}

async function refundTransaction(transaction, user) {
  /* Create negative transactions for the received transaction */
  return await createRefundTransaction(transaction, 0, null, user);
}

/* Expected API of a Payment Method Type */
export default {
  features: {
    recurring: true,
    waitToCharge: false,
  },
  getBalance,
  processOrder,
  refundTransaction,
};
