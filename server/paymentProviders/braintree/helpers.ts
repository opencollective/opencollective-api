import braintree from 'braintree';
import { isEmpty, isNil, omitBy } from 'lodash';

import { PAYMENT_METHOD_SERVICE } from '../../constants/paymentMethods';
import { TransactionTypes } from '../../constants/transactions';
import { convertToCurrency } from '../../lib/currency';
import { floatAmountToCents } from '../../lib/math';
import { getHostFee, getPlatformFee } from '../../lib/payments';
import models, { Op } from '../../models';

const extractFees = (braintreeTransaction): number => {
  if (!isNil(braintreeTransaction['paypal']?.transactionFeeAmount)) {
    return floatAmountToCents(braintreeTransaction['paypal'].transactionFeeAmount);
  } else {
    // TODO(Braintree): find a way to retrieve this info for non-paypal transactions
    return 0;
  }
};

export const cleanBraintreeTransactionForData = (
  braintreeTransaction: braintree.Transaction,
): Record<string, unknown> => {
  const excludedFields = [
    'samsungPayCard',
    'visaCheckoutCard',
    'androidPayCard',
    'applePayCard',
    'localPayment',
    'merchantAddress',
    'disbursementDetails',
    'billing',
  ];

  return omitBy(braintreeTransaction, (value, key) => {
    return excludedFields.includes(key) || (typeof value === 'object' && isEmpty(value));
  });
};

export class BraintreeTransactionAlreadyExistsError extends Error {
  braintreeTransaction: braintree.Transaction;
  dbTransaction: typeof models.Transaction;

  constructor(braintreeTransaction: braintree.Transaction, dbTransaction: typeof models.Transaction) {
    super(`Braintree transactions for ${braintreeTransaction.id} already exist, skipping.`);
    this.dbTransaction = dbTransaction;
    this.braintreeTransaction = braintreeTransaction;
  }
}

export const createTransactionsPairFromBraintreeTransaction = async (
  order: typeof models.Order,
  braintreeTransaction: braintree.Transaction,
): Promise<typeof models.Transaction> => {
  const host = await order.collective.getHostCollective();

  // Make sure the transaction is not already recorded
  const existingTransactions = await models.Transaction.findAll({
    where: {
      HostCollectiveId: host.id,
      data: { braintreeTransaction: { id: braintreeTransaction.id } }, // TODO(Braintree): Add index on this field
    },
  });

  if (existingTransactions.length) {
    throw new BraintreeTransactionAlreadyExistsError(braintreeTransaction, existingTransactions[0]);
  }

  const amountInHostCurrency = floatAmountToCents(parseFloat(braintreeTransaction.amount));
  const paymentProcessorFeeInHostCurrency = extractFees(braintreeTransaction);
  const amountInOrderCurrency = await convertToCurrency(amountInHostCurrency, host.currency, order.currency);
  return models.Transaction.createFromPayload({
    CreatedByUserId: order.CreatedByUserId,
    FromCollectiveId: order.FromCollectiveId,
    CollectiveId: order.CollectiveId,
    PaymentMethodId: order.PaymentMethodId,
    transaction: {
      type: TransactionTypes.CREDIT,
      OrderId: order.id,
      amount: amountInOrderCurrency,
      currency: order.currency,
      hostCurrency: host.currency,
      amountInHostCurrency: amountInHostCurrency,
      hostCurrencyFxRate: amountInHostCurrency / amountInOrderCurrency,
      paymentProcessorFeeInHostCurrency,
      taxAmount: order.taxAmount,
      description: order.description,
      hostFeeInHostCurrency: await getHostFee(amountInHostCurrency, order),
      platformFeeInHostCurrency: await getPlatformFee(amountInHostCurrency, order),
      data: {
        braintreeTransaction: cleanBraintreeTransactionForData(braintreeTransaction),
        isFeesOnTop: Boolean(order.data?.isFeesOnTop),
      },
    },
  });
};

/**
 * Retrieves the most recent `customer_id`
 */
export const getCustomerIdFromCollective = async (
  fromCollective: typeof models.Collective,
): Promise<string | undefined> => {
  const braintreePaymentMethod = await models.PaymentMethod.findOne({
    order: [['createdAt', 'DESC']],
    where: {
      CollectiveId: fromCollective.id,
      service: PAYMENT_METHOD_SERVICE.BRAINTREE,
      data: { customerId: { [Op.not]: null } },
    },
  });

  return braintreePaymentMethod?.data?.customerId;
};
