import config from 'config';
import { get, result, toUpper } from 'lodash';

import * as constants from '../../constants/transactions';
import {
  createRefundTransaction,
  getHostFee,
  getHostFeeSharePercent,
  getPlatformTip,
  isPlatformTipEligible,
} from '../../lib/payments';
import stripe, { convertFromStripeAmount, extractFees, retrieveChargeWithRefund } from '../../lib/stripe';
import models from '../../models';

export const APPLICATION_FEE_INCOMPATIBLE_CURRENCIES = ['BRL'];

/** Refund a given transaction */
export const refundTransaction = async (
  transaction: typeof models.Transaction,
  user: typeof models.User,
  options?: { checkRefundStatus: boolean },
): Promise<typeof models.Transaction> => {
  /* What's going to be refunded */
  const chargeId: string = result(transaction.data, 'charge.id');
  if (transaction.data?.refund?.status === 'pending') {
    throw new Error(`Transaction #${transaction.id} refund was already requested and it is pending`);
  }

  /* From which stripe account it's going to be refunded */
  const collective = await models.Collective.findByPk(
    transaction.type === 'CREDIT' ? transaction.CollectiveId : transaction.FromCollectiveId,
  );
  const hostStripeAccount = await collective.getHostStripeAccount();

  /* Refund both charge & application fee */
  const fees = get(transaction.data, 'balanceTransaction.fee_details', []);
  const hasApplicationFees = fees.some(fee => fee.type === 'application_fee' && fee.amount > 0);
  const refund = await stripe.refunds.create(
    { charge: chargeId, refund_application_fee: hasApplicationFees }, // eslint-disable-line camelcase
    { stripeAccount: hostStripeAccount.username },
  );

  if (options?.checkRefundStatus && refund.status !== 'succeeded') {
    await transaction.update({ data: { ...transaction.data, refund } });
    return null;
  }

  const charge = await stripe.charges.retrieve(chargeId, { stripeAccount: hostStripeAccount.username });
  const refundBalance = await stripe.balanceTransactions.retrieve(refund.balance_transaction as string, {
    stripeAccount: hostStripeAccount.username,
  });
  const refundedFees = extractFees(refundBalance, refundBalance.currency);

  /* Create negative transactions for the received transaction */
  return await createRefundTransaction(
    transaction,
    refundedFees.stripeFee, // TODO: Ignoring `other` fees here could be a problem
    {
      ...transaction.data,
      refund,
      balanceTransaction: refundBalance, // TODO: This is overwriting the original balanceTransaction with the refund balance transaction, which remove important info
      charge,
    },
    user,
  );
};

/** Refund a given transaction that was already refunded
 * in stripe but not in our database
 */
export const refundTransactionOnlyInDatabase = async (
  transaction: typeof models.Transaction,
  user: typeof models.User,
): Promise<typeof models.Transaction> => {
  /* What's going to be refunded */
  const chargeId = result(transaction.data, 'charge.id');

  /* From which stripe account it's going to be refunded */
  const collective = await models.Collective.findByPk(
    transaction.type === 'CREDIT' ? transaction.CollectiveId : transaction.FromCollectiveId,
  );
  const hostStripeAccount = await collective.getHostStripeAccount();

  /* Refund both charge & application fee */
  const { charge, refund, dispute } = await retrieveChargeWithRefund(chargeId, hostStripeAccount);
  if (!refund && !dispute) {
    throw new Error('No refund or dispute found in Stripe.');
  }
  const refundBalance = await stripe.balanceTransactions.retrieve(
    (refund.balance_transaction || dispute.balance_transactions[0].id) as string,
    {
      stripeAccount: hostStripeAccount.username,
    },
  );
  const fees = extractFees(refundBalance, refundBalance.currency);

  /* Create negative transactions for the received transaction */
  return await createRefundTransaction(
    transaction,
    refund ? fees.stripeFee : 0, // With disputes, we get 1500 as a value but will not handle this
    { ...transaction.data, charge, refund, balanceTransaction: refundBalance },
    user,
  );
};

export const createChargeTransactions = async (charge, { order }) => {
  const host = await order.collective.getHostCollective();
  const hostStripeAccount = await order.collective.getHostStripeAccount();
  const isPlatformRevenueDirectlyCollected = APPLICATION_FEE_INCOMPATIBLE_CURRENCIES.includes(toUpper(host.currency))
    ? false
    : host?.settings?.isPlatformRevenueDirectlyCollected ?? true;

  const hostFeeSharePercent = await getHostFeeSharePercent(order, host);
  const isSharedRevenue = !!hostFeeSharePercent;
  const balanceTransaction = await stripe.balanceTransactions.retrieve(charge.balance_transaction, {
    stripeAccount: hostStripeAccount.username,
  });

  // Create a Transaction
  const amount = order.totalAmount;
  const currency = order.currency;
  const hostCurrency = balanceTransaction.currency.toUpperCase();
  const amountInHostCurrency = convertFromStripeAmount(balanceTransaction.currency, balanceTransaction.amount);
  const hostCurrencyFxRate = amountInHostCurrency / order.totalAmount;

  const hostFee = await getHostFee(order, host);
  const hostFeeInHostCurrency = Math.round(hostFee * hostCurrencyFxRate);

  const fees = extractFees(balanceTransaction, balanceTransaction.currency);

  const platformTipEligible = await isPlatformTipEligible(order, host);
  const platformTip = getPlatformTip(order);

  let platformTipInHostCurrency, platformFeeInHostCurrency;
  if (platformTip) {
    platformTipInHostCurrency = isSharedRevenue
      ? Math.round(platformTip * hostCurrencyFxRate) || 0
      : fees.applicationFee;
  } else if (config.env === 'test' || config.env === 'ci') {
    // Retro Compatibility with some tests expecting Platform Fees, not for production anymore
    // TODO: we need to stop supporting this
    platformFeeInHostCurrency = fees.applicationFee;
  }

  const paymentProcessorFeeInHostCurrency = fees.stripeFee;

  const data = {
    charge,
    balanceTransaction,
    hasPlatformTip: platformTip ? true : false,
    isSharedRevenue,
    platformTipEligible,
    platformTip,
    platformTipInHostCurrency,
    hostFeeSharePercent,
    settled: true,
    tax: order.data?.tax,
  };

  const transactionPayload = {
    CreatedByUserId: order.CreatedByUserId,
    FromCollectiveId: order.FromCollectiveId,
    CollectiveId: order.CollectiveId,
    PaymentMethodId: order.PaymentMethodId,
    type: constants.TransactionTypes.CREDIT,
    OrderId: order.id,
    amount,
    currency,
    hostCurrency,
    amountInHostCurrency,
    hostCurrencyFxRate,
    paymentProcessorFeeInHostCurrency,
    platformFeeInHostCurrency,
    taxAmount: order.taxAmount,
    description: order.description,
    hostFeeInHostCurrency,
    data,
  };

  return models.Transaction.createFromContributionPayload(transactionPayload, {
    isPlatformRevenueDirectlyCollected,
  });
};
