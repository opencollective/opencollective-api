import config from 'config';
import { get, result, toUpper } from 'lodash';
import moment from 'moment';
import type { CreateOptions } from 'sequelize';
import Stripe from 'stripe';

import { Service } from '../../constants/connected-account';
import { SupportedCurrency } from '../../constants/currencies';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../constants/paymentMethods';
import * as constants from '../../constants/transactions';
import { isSupportedCurrency } from '../../lib/currency';
import logger from '../../lib/logger';
import {
  createRefundTransaction,
  getHostFee,
  getHostFeeSharePercent,
  getPlatformTip,
  isPlatformTipEligible,
} from '../../lib/payments';
import { reportMessageToSentry } from '../../lib/sentry';
import stripe, { convertFromStripeAmount, extractFees, retrieveChargeWithRefund } from '../../lib/stripe';
import models, { Collective, ConnectedAccount } from '../../models';
import { OrderModelInterface } from '../../models/Order';
import PaymentMethod, { PaymentMethodModelInterface } from '../../models/PaymentMethod';
import { TransactionCreationAttributes, TransactionData, TransactionInterface } from '../../models/Transaction';
import User from '../../models/User';

export const APPLICATION_FEE_INCOMPATIBLE_CURRENCIES = ['BRL'];

/** Refund a given transaction */
export const refundTransaction = async (
  transaction: TransactionInterface,
  user?: User,
  reason?: string,
): Promise<TransactionInterface> => {
  /* What's going to be refunded */
  const chargeId: string = result(transaction.data, 'charge.id');
  if (transaction.data?.refund?.['status'] === 'pending') {
    throw new Error(`Transaction #${transaction.id} refund was already requested and it is pending`);
  }

  /* From which stripe account it's going to be refunded */
  const collective = await models.Collective.findByPk(
    transaction.type === 'CREDIT' ? transaction.CollectiveId : transaction.FromCollectiveId,
  );
  const hostStripeAccount = await collective.getHostStripeAccount();

  /* Refund both charge & application fee */
  const fees = get(transaction.data, 'balanceTransaction.fee_details', []) as Stripe.BalanceTransaction.FeeDetail[];
  const hasApplicationFees = fees.some(fee => fee.type === 'application_fee' && fee.amount > 0);
  const refund = await stripe.refunds.create(
    { charge: chargeId, refund_application_fee: hasApplicationFees }, // eslint-disable-line camelcase
    { stripeAccount: hostStripeAccount.username },
  );

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
      refundReason: reason,
    },
    user,
  );
};

/** Refund a given transaction that was already refunded
 * in stripe but not in our database
 */
export const refundTransactionOnlyInDatabase = async (
  transaction: TransactionInterface,
  user?: User,
  reason?: string,
): Promise<TransactionInterface> => {
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
    (refund?.balance_transaction || dispute?.balance_transactions[0].id) as string,
    {
      stripeAccount: hostStripeAccount.username,
    },
  );
  const fees = extractFees(refundBalance, refundBalance.currency);

  /* Create negative transactions for the received transaction */
  return await createRefundTransaction(
    transaction,
    refund ? fees.stripeFee : 0, // With disputes, we get 1500 as a value but will not handle this
    { ...transaction.data, charge, refund, balanceTransaction: refundBalance, refundReason: reason },
    user,
  );
};

export const createChargeTransactions = async (
  charge: Stripe.Charge,
  {
    order,
  }: {
    order: OrderModelInterface;
  },
) => {
  const host = await order.collective.getHostCollective();
  const hostStripeAccount = await order.collective.getHostStripeAccount();
  const isPlatformRevenueDirectlyCollected =
    host && APPLICATION_FEE_INCOMPATIBLE_CURRENCIES.includes(toUpper(host.currency))
      ? false
      : host?.settings?.isPlatformRevenueDirectlyCollected ?? true;

  const hostFeeSharePercent = await getHostFeeSharePercent(order);
  const isSharedRevenue = !!hostFeeSharePercent;
  const balanceTransaction = await stripe.balanceTransactions.retrieve(charge.balance_transaction as string, {
    stripeAccount: hostStripeAccount.username,
  });

  // Create a Transaction
  const amount = order.totalAmount;
  const currency = order.currency;
  const hostCurrency = balanceTransaction.currency.toUpperCase() as SupportedCurrency;
  if (!isSupportedCurrency(hostCurrency)) {
    reportMessageToSentry(`Unsupported currency ${hostCurrency} for transaction ${order.id}`);
  }

  const amountInHostCurrency = convertFromStripeAmount(balanceTransaction.currency, balanceTransaction.amount);
  const hostCurrencyFxRate = amountInHostCurrency / order.totalAmount;

  const hostFee = await getHostFee(order);
  const hostFeeInHostCurrency = Math.round(hostFee * hostCurrencyFxRate);

  const fees = extractFees(balanceTransaction, balanceTransaction.currency);

  const platformTipEligible = await isPlatformTipEligible(order);
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

  const clearedAt = charge.created ? moment.unix(charge.created).toDate() : null;

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
    tax: order.data?.tax,
    isPlatformRevenueDirectlyCollected,
  } as TransactionData;

  const transactionPayload = {
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
    paymentProcessorFeeInHostCurrency,
    hostFeeInHostCurrency,
    platformFeeInHostCurrency,
    taxAmount: order.taxAmount,
    description: order.description,
    data,
    clearedAt,
  } as TransactionCreationAttributes;

  return models.Transaction.createFromContributionPayload(transactionPayload);
};

/**
 * Returns the stripe card payment method to be used for this order.
 */
export async function resolvePaymentMethodForOrder(
  hostStripeAccount: string,
  order: OrderModelInterface,
): Promise<{ id: string; customer: string }> {
  const isPlatformHost = hostStripeAccount === config.stripe.accountId;

  const user = await order.getUser();

  let paymentMethod = order.paymentMethod;
  // a new card token to attach on the platform account
  if (!paymentMethod.customerId) {
    paymentMethod = await attachCardToPlatformCustomer(paymentMethod, order.fromCollective, user);
  }

  const isPlatformPaymentMethod =
    !paymentMethod.data?.stripeAccount || paymentMethod.data?.stripeAccount === config.stripe.accountId;

  if (isPlatformHost && !isPlatformPaymentMethod) {
    throw new Error('Cannot clone payment method from connected account to platform account');
  }

  if (!isPlatformPaymentMethod && paymentMethod.data?.stripeAccount !== hostStripeAccount) {
    throw new Error('Cannot clone payment method that are not attached to the platform account');
  }

  if ((isPlatformHost && isPlatformPaymentMethod) || paymentMethod.data?.stripeAccount === hostStripeAccount) {
    return {
      id: paymentMethod.data?.stripePaymentMethodId,
      customer: paymentMethod.customerId,
    };
  }

  // in the previous implementation, each user card was cloned to a different host stripe customer.
  // the corresponding customer was stored here, and we used its default source to charge.
  // we will still use this customer (present in some payment methods created before 2022), as these cards
  // might have expired and are not clonable.
  if (paymentMethod.data?.customerIdForHost && paymentMethod.data?.customerIdForHost?.[hostStripeAccount]) {
    const customerId = paymentMethod.data?.customerIdForHost?.[hostStripeAccount];
    const customer = await stripe.customers.retrieve(customerId, {
      stripeAccount: hostStripeAccount,
    });

    const paymentMethodId = get(customer, 'default_source', get(customer, 'sources.data[0].id'));

    return {
      id: paymentMethodId,
      customer: customerId,
    };
  }

  const hostCustomer = await getOrCreateStripeCustomer(hostStripeAccount, order.fromCollective, user);
  return await getOrCloneCardPaymentMethod(paymentMethod, order.fromCollective, hostStripeAccount, hostCustomer);
}

export async function getOrCreateStripeCustomer(
  stripeAccount: string,
  collective: Collective,
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
  paymentMethod: PaymentMethodModelInterface,
  collective: Collective,
  user: User,
): Promise<PaymentMethodModelInterface> {
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
  platformPaymentMethod: PaymentMethodModelInterface,
  collective: Collective,
  hostStripeAccount: string,
  hostCustomer: string,
): Promise<{ id: string; customer: string }> {
  let platformCardTokenCardId = platformPaymentMethod.data?.stripePaymentMethodId;
  let platformCardFingerprint = platformPaymentMethod.data?.fingerprint;

  // store platform card payment method id and fingerprint for reuse.
  if (!platformCardTokenCardId || !platformCardFingerprint) {
    const platformCardToken = await stripe.tokens.retrieve(platformPaymentMethod.token);
    platformCardFingerprint = platformCardToken.card.fingerprint;
    platformCardTokenCardId = platformCardToken.card.id;

    await platformPaymentMethod.update({
      data: {
        ...platformPaymentMethod.data,
        fingerprint: platformCardFingerprint,
        stripePaymentMethodId: platformCardTokenCardId,
      },
    });
  }

  if (platformPaymentMethod.data?.stripePaymentMethodByHostCustomer?.[hostCustomer]) {
    return {
      id: platformPaymentMethod.data?.stripePaymentMethodByHostCustomer[hostCustomer],
      customer: hostCustomer,
    };
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

  await platformPaymentMethod.update({
    data: {
      ...platformPaymentMethod.data,
      stripePaymentMethodByHostCustomer: {
        ...platformPaymentMethod.data?.stripePaymentMethodByHostCustomer,
        [hostCustomer]: clonedPaymentMethod.id,
      },
    },
  });

  return {
    id: platformPaymentMethod.data?.stripePaymentMethodByHostCustomer[hostCustomer],
    customer: hostCustomer,
  };
}

function formatPaymentMethodName(
  paymentMethod: Stripe.PaymentMethod,
  chargePaymentMethodDetails?: Stripe.Charge.PaymentMethodDetails,
) {
  switch (paymentMethod.type) {
    case PAYMENT_METHOD_TYPE.US_BANK_ACCOUNT: {
      return `${paymentMethod.us_bank_account.bank_name} ****${paymentMethod.us_bank_account.last4}`;
    }
    case PAYMENT_METHOD_TYPE.SEPA_DEBIT: {
      return `${paymentMethod.sepa_debit.bank_code} ****${paymentMethod.sepa_debit.last4}`;
    }
    case 'card': {
      return paymentMethod.card.last4;
    }
    case PAYMENT_METHOD_TYPE.BACS_DEBIT: {
      return `${paymentMethod.bacs_debit.sort_code} ****${paymentMethod.bacs_debit.last4}`;
    }
    case PAYMENT_METHOD_TYPE.BANCONTACT: {
      return `${chargePaymentMethodDetails?.bancontact?.bank_code} ***${chargePaymentMethodDetails?.bancontact?.iban_last4}`;
    }
    // TODO
    // support PAYMENT_METHOD_TYPE.LINK
    default: {
      return '';
    }
  }
}

function mapStripePaymentMethodExtraData(
  pm: Stripe.PaymentMethod,
  chargePaymentMethodDetails?: Stripe.Charge.PaymentMethodDetails,
): object {
  if (pm.type === 'card') {
    return {
      brand: pm.card.brand,
      country: pm.card.country,
      expYear: pm.card.exp_year,
      expMonth: pm.card.exp_month,
      funding: pm.card.funding,
      fingerprint: pm.card.fingerprint,
      wallet: pm.card.wallet,
    };
  }

  if (pm.type === 'bancontact') {
    return {
      ...pm['bancontact'],
      ...chargePaymentMethodDetails?.['bancontact'],
    };
  }

  return pm[pm.type];
}

const coercePaymentMethodType = (paymentMethodType: Stripe.PaymentMethod.Type): PAYMENT_METHOD_TYPE => {
  switch (paymentMethodType) {
    case 'card':
      return PAYMENT_METHOD_TYPE.CREDITCARD;
    case 'sepa_debit':
      return PAYMENT_METHOD_TYPE.SEPA_DEBIT;
    case 'bacs_debit':
      return PAYMENT_METHOD_TYPE.BACS_DEBIT;
    case 'us_bank_account':
      return PAYMENT_METHOD_TYPE.US_BANK_ACCOUNT;
    case 'alipay':
      return PAYMENT_METHOD_TYPE.ALIPAY;
    case 'bancontact':
      return PAYMENT_METHOD_TYPE.BANCONTACT;
    case 'link':
      return PAYMENT_METHOD_TYPE.LINK;
    default:
      logger.warn(`Unknown payment method type: ${paymentMethodType}`);
      return paymentMethodType as PAYMENT_METHOD_TYPE;
  }
};

export async function createPaymentMethod(
  {
    stripePaymentMethod,
    stripeAccount,
    stripeCustomer,
    attachedToCustomer,
    originPaymentIntent,
    extraData,
    CollectiveId,
    CreatedByUserId,
  }: {
    stripePaymentMethod: Stripe.PaymentMethod;
    stripeAccount: string;
    stripeCustomer: string;
    attachedToCustomer?: boolean;
    originPaymentIntent?: Stripe.PaymentIntent;
    extraData?: object;
    CollectiveId?: number;
    CreatedByUserId?: number;
  },
  createOptions?: CreateOptions,
): Promise<PaymentMethodModelInterface> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paymentIntentCharge: Stripe.Charge = (originPaymentIntent as any)?.charges?.data?.[0];
  const paymentMethodChargeDetails = paymentIntentCharge?.payment_method_details;

  const paymentMethodData = {
    stripePaymentMethodId: stripePaymentMethod.id,
    stripeAccount,
    ...mapStripePaymentMethodExtraData(stripePaymentMethod, paymentMethodChargeDetails),
    ...extraData,
  };

  const paymentMethodName = formatPaymentMethodName(stripePaymentMethod, paymentMethodChargeDetails);

  return await PaymentMethod.create(
    {
      type: coercePaymentMethodType(stripePaymentMethod.type),
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      name: paymentMethodName,
      token: stripePaymentMethod.id,
      customerId: stripeCustomer,
      CollectiveId,
      CreatedByUserId,
      saved:
        attachedToCustomer ||
        (stripePaymentMethod.type !== 'bancontact' && originPaymentIntent?.setup_future_usage === 'off_session'),
      confirmedAt: new Date(),
      data: paymentMethodData,
    },
    createOptions,
  );
}

export async function createOrRetrievePaymentMethodFromSetupIntent(
  setupIntent: Stripe.SetupIntent,
): Promise<PaymentMethodModelInterface> {
  const stripePaymentMethodId =
    typeof setupIntent.payment_method === 'string' ? setupIntent.payment_method : setupIntent.payment_method.id;

  const existingPaymentMethod = await PaymentMethod.findOne({
    where: {
      data: {
        stripePaymentMethodId,
      },
    },
  });

  if (existingPaymentMethod) {
    if (existingPaymentMethod.type === PAYMENT_METHOD_TYPE.BANCONTACT) {
      return await PaymentMethod.findOne({
        where: {
          data: {
            stripePaymentMethodId: existingPaymentMethod.data.generated_sepa_debit,
          },
        },
      });
    }
    return existingPaymentMethod;
  }

  if (['requires_payment_method', 'canceled'].includes(setupIntent.status)) {
    throw new Error(`Invalid setup intent status: ${setupIntent.status}`);
  }

  const customerId = typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer.id;
  if (!customerId) {
    throw new Error('Setup intent not attached to a customer');
  }

  const customerConnectedAccount = await ConnectedAccount.findOne({
    where: {
      service: Service.STRIPE_CUSTOMER,
      username: customerId,
    },
    include: [
      {
        model: Collective,
        as: 'collective',
        required: true,
      },
    ],
  });

  if (!customerConnectedAccount) {
    throw new Error('Customer connected account not found');
  }

  const originalPaymentMethod = await createOrRetrieveStripePaymentMethod(
    stripePaymentMethodId,
    customerConnectedAccount,
    {
      saved: setupIntent.usage === 'off_session',
      confirmed: 'succeeded' === setupIntent.status,
    },
  );

  if (originalPaymentMethod.type === PAYMENT_METHOD_TYPE.BANCONTACT) {
    let latestAttempt = setupIntent.latest_attempt;

    if (typeof latestAttempt === 'string') {
      const si = await stripe.setupIntents.retrieve(
        setupIntent.id,
        {
          expand: ['latest_attempt'],
        },
        {
          stripeAccount: customerConnectedAccount.clientId,
        },
      );

      latestAttempt = si.latest_attempt as Stripe.SetupAttempt;
    }

    await originalPaymentMethod.update({
      data: {
        ...originalPaymentMethod.data,
        ...latestAttempt.payment_method_details?.['bancontact'],
      },
    });

    const generatedSepaPaymentId = latestAttempt.payment_method_details.bancontact.generated_sepa_debit as string;
    const generatedPaymentMethod = await createOrRetrieveStripePaymentMethod(
      generatedSepaPaymentId,
      customerConnectedAccount,
      {
        saved: setupIntent.usage === 'off_session',
        confirmed: 'succeeded' === setupIntent.status,
      },
    );

    return generatedPaymentMethod;
  }

  return originalPaymentMethod;
}

async function createOrRetrieveStripePaymentMethod(
  stripePaymentMethodId: string,
  customerConnectedAccount: ConnectedAccount,
  options?: {
    saved?: boolean;
    confirmed?: boolean;
  },
) {
  const existingPaymentMethod = await PaymentMethod.findOne({
    where: {
      data: {
        stripePaymentMethodId,
      },
    },
  });
  if (existingPaymentMethod) {
    return existingPaymentMethod;
  }

  const stripeAccount = customerConnectedAccount.clientId;
  const stripePaymentMethod = await stripe.paymentMethods.retrieve(stripePaymentMethodId, {
    stripeAccount,
  });

  if (!stripePaymentMethod) {
    throw new Error(`Stripe Payment Method ${stripePaymentMethodId} not found for account ${stripeAccount}`);
  }

  const paymentMethodData = {
    stripePaymentMethodId,
    stripeAccount,
    ...mapStripePaymentMethodExtraData(stripePaymentMethod),
  };

  const paymentMethodName = formatPaymentMethodName(stripePaymentMethod);

  return await PaymentMethod.create({
    type: coercePaymentMethodType(stripePaymentMethod.type),
    service: PAYMENT_METHOD_SERVICE.STRIPE,
    name: paymentMethodName,
    token: stripePaymentMethod.id,
    customerId: customerConnectedAccount.username,
    CollectiveId: customerConnectedAccount.CollectiveId,
    CreatedByUserId: customerConnectedAccount.CreatedByUserId,
    saved: options?.saved,
    confirmedAt: options?.confirmed ? new Date() : null,
    data: paymentMethodData,
  });
}
