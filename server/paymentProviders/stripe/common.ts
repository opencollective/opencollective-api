import config from 'config';
import { get, result, toUpper } from 'lodash';

import { Service } from '../../constants/connected_account';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../constants/paymentMethods';
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
import User from '../../models/User';

export const APPLICATION_FEE_INCOMPATIBLE_CURRENCIES = ['BRL'];

/** Refund a given transaction */
export const refundTransaction = async (
  transaction: typeof models.Transaction,
  user: User,
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
  user: User,
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

/**
 * Returns the stripe card payment method to be used for this order.
 */
export async function resolvePaymentMethodForOrder(
  hostStripeAccount: string,
  order: typeof models.Order,
): Promise<typeof models.PaymentMethod> {
  const isPlatformHost = hostStripeAccount === config.stripe.accountId;

  const user = await order.getUser();

  let paymentMethod = order.paymentMethod;
  // a new card token to attach on the platform account
  if (!paymentMethod.customerId) {
    paymentMethod = await attachCardToPlatformCustomer(paymentMethod, order.fromCollective, user);
  }

  const isPlatformPaymentMethod =
    !paymentMethod?.data?.stripeAccount || paymentMethod?.data?.stripeAccount === config.stripe.accountId;

  if (isPlatformHost && !isPlatformPaymentMethod) {
    throw new Error('Cannot clone payment method from connected account to platform account');
  }

  if (!isPlatformPaymentMethod && order.paymentMethod?.data?.stripeAccount !== hostStripeAccount) {
    throw new Error('Cannot clone payment method that are not attached to the platform account');
  }

  if (isPlatformPaymentMethod && !isPlatformHost) {
    const hostCustomer = await getOrCreateStripeCustomer(hostStripeAccount, order.fromCollective, user);
    paymentMethod = await getOrCloneCardPaymentMethod(
      paymentMethod,
      order.fromCollective,
      hostStripeAccount,
      hostCustomer,
    );
  }

  return paymentMethod;
}

export async function getOrCreateStripeCustomer(
  stripeAccount: string,
  collective: typeof models.Collective,
  user: User,
): Promise<string> {
  let stripeCustomerConnectedAccount = await collective.getCustomerStripeAccount(stripeAccount);
  // customer was not yet created for this host, so create it
  if (!stripeCustomerConnectedAccount) {
    const customer = await stripe.customers.create(
      {
        email: user?.email,
        description: `${config.host.website}/${collective.slug}`,
      },
      {
        stripeAccount,
      },
    );

    stripeCustomerConnectedAccount = await models.ConnectedAccount.create({
      clientId: stripeAccount,
      username: customer.id,
      CollectiveId: collective.id,
      service: Service.STRIPE_CUSTOMER,
    });
  }

  return stripeCustomerConnectedAccount.username;
}

export async function attachCardToPlatformCustomer(
  paymentMethod: typeof models.PaymentMethod,
  collective: typeof models.Collective,
  user: User,
): Promise<typeof models.PaymentMethod> {
  const platformCustomer = await getOrCreateStripeCustomer(config.stripe.accountId, collective, user);

  let stripePaymentMethod = await stripe.paymentMethods.create({
    type: 'card',
    card: {
      token: paymentMethod.token,
    },
  });

  stripePaymentMethod = await stripe.paymentMethods.attach(stripePaymentMethod.id, {
    customer: platformCustomer,
  });

  return await paymentMethod.update({
    customerId: platformCustomer,
    data: {
      ...paymentMethod.data,
      stripePaymentMethodId: stripePaymentMethod.id,
      fingerprint: stripePaymentMethod.card.fingerprint,
    },
  });
}

export async function getOrCloneCardPaymentMethod(
  platformPaymentMethod: typeof models.PaymentMethod,
  collective: typeof models.Collective,
  hostStripeAccount: string,
  hostCustomer: string,
) {
  let platformCardTokenCardId = platformPaymentMethod.data?.stripePaymentMethodId;
  let platformCardFingerprint = platformPaymentMethod.data?.fingerprint;

  // store platform card payment method id and fingerprint for reuse.
  if (!platformCardTokenCardId || !platformCardFingerprint) {
    const platformCardToken = await stripe.tokens.retrieve(platformPaymentMethod.token);
    platformCardFingerprint = platformCardToken.card.fingerprint;
    platformCardTokenCardId = platformCardToken.card.id;

    await platformPaymentMethod.update({
      data: {
        ...platformPaymentMethod?.data,
        fingerprint: platformCardFingerprint,
        stripePaymentMethodId: platformCardTokenCardId,
      },
    });
  }

  const cardPaymentMethodOnHostAccount = await models.PaymentMethod.findOne({
    where: {
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      type: PAYMENT_METHOD_TYPE.CREDITCARD,
      CollectiveId: collective.id,
      data: {
        stripeAccount: hostStripeAccount,
        fingerprint: platformCardFingerprint,
      },
    },
  });

  // card was already cloned to fiscal host customer account
  if (cardPaymentMethodOnHostAccount) {
    return cardPaymentMethodOnHostAccount;
  }

  // clone payment method to host stripe account
  let clonedPaymentMethod = await stripe.paymentMethods.create(
    {
      // this is the customer on the platform account which holds the original card
      customer: platformPaymentMethod.customerId,
      // eslint-disable-next-line camelcase
      payment_method: platformCardTokenCardId,
    },
    {
      stripeAccount: hostStripeAccount,
    },
  );

  // we attach the newly cloned payment method to the customer in the fiscal host account
  clonedPaymentMethod = await stripe.paymentMethods.attach(
    clonedPaymentMethod.id,
    {
      customer: hostCustomer,
    },
    {
      stripeAccount: hostStripeAccount,
    },
  );

  return await models.PaymentMethod.create({
    customerId: hostCustomer,
    CollectiveId: collective.id,
    service: PAYMENT_METHOD_SERVICE.STRIPE,
    type: PAYMENT_METHOD_TYPE.CREDITCARD,
    confirmedAt: new Date(),
    token: clonedPaymentMethod.id,
    data: {
      stripePaymentMethodId: clonedPaymentMethod.id,
      stripeAccount: hostStripeAccount,
      ...clonedPaymentMethod[clonedPaymentMethod.type],
    },
  });
}
