import { get } from 'lodash';
import moment from 'moment';

import { TransactionKind } from '../../constants/transaction-kind';
import * as currency from '../../lib/currency';
import { createRefundTransaction, findPaymentMethodProvider, isProvider } from '../../lib/payments';
import models, { Op } from '../../models';

/**
 * Gift Card Payment method - This payment Method works basically as an alias
 * to other Payment method(field "SourcePaymentMethodId") that will create transactions
 * and then the payment methods of those transactions will be replaced by
 * the gift card payment method that first processed the order.
 */

/** Get the balance of a gift card card
 * @param {models.PaymentMethod} paymentMethod is the instance of the
 *  gift card payment method.
 * @return {Object} with amount & currency from the payment method.
 */
async function getBalance(paymentMethod) {
  if (!isProvider('opencollective.giftcard', paymentMethod)) {
    throw new Error(`Expected opencollective.giftcard but got ${paymentMethod.service}.${paymentMethod.type}`);
  }
  let query = {
    PaymentMethodId: paymentMethod.id,
    kind: { [Op.ne]: TransactionKind.PAYMENT_PROCESSOR_COVER },
    type: 'DEBIT',
    RefundTransactionId: null,
  };
  let initialBalance = paymentMethod.initialBalance;
  if (paymentMethod.monthlyLimitPerMember) {
    // consider initial balance as monthly limit
    initialBalance = paymentMethod.monthlyLimitPerMember;
    // find first and last days of current month(first and last ms of those days)
    const date = new Date();
    const firstDay = new Date(date.getFullYear(), date.getMonth(), 1);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    lastDay.setHours(23, 59, 59, 999);
    // update query to filter result through the dates
    query = { ...query, createdAt: { [Op.between]: [firstDay, lastDay] } };
  }
  /* Result will be negative (We're looking for DEBIT transactions) */
  const allTransactions = await models.Transaction.findAll({
    attributes: ['netAmountInCollectiveCurrency', 'currency'],
    where: query,
  });
  let spent = 0;
  for (const transaction of allTransactions) {
    if (transaction.currency !== paymentMethod.currency) {
      const fxRate = await currency.getFxRate(transaction.currency, paymentMethod.currency);
      spent += transaction.netAmountInCollectiveCurrency * fxRate;
    } else {
      spent += transaction.netAmountInCollectiveCurrency;
    }
  }
  const balance = {
    amount: currency.roundCentsAmount(initialBalance + spent, paymentMethod.currency),
    currency: paymentMethod.currency,
  };
  return balance;
}

/** Process a gift card order
 *
 * @param {models.Order} order The order instance to be processed.
 * @return {models.Transaction} the double entry generated transactions.
 */
async function processOrder(order) {
  const paymentMethod = await models.PaymentMethod.findByPk(order.paymentMethod.id);
  // check if payment Method has expired
  if (!paymentMethod.expiryDate || moment(paymentMethod.expiryDate) < moment()) {
    throw new Error('Payment method has already expired');
  }

  // Checking if balance is ok or will still be after completing the order
  const balance = await getBalance(paymentMethod);
  if (balance.amount <= 0) {
    throw new Error('This payment method has no balance to complete this order');
  }
  // converting(or keeping if it's the same currency) order amount to the payment method currency
  let orderAmountInPaymentMethodCurrency = order.totalAmount;
  if (order.currency !== paymentMethod.currency) {
    const fxRate = await currency.getFxRate(order.currency, paymentMethod.currency);
    orderAmountInPaymentMethodCurrency = order.totalAmount * fxRate;
  }
  if (balance.amount - orderAmountInPaymentMethodCurrency < 0) {
    throw new Error(`Order amount exceeds balance(${balance.amount} ${paymentMethod.currency})`);
  }

  // Making sure the SourcePaymentMethodId is Set(requirement for gift cards)
  if (!get(paymentMethod, 'SourcePaymentMethodId')) {
    throw new Error('Gift Card payment method must have a value a "SourcePaymentMethodId" defined');
  }
  // finding Source Payment method and update order payment method properties
  const sourcePaymentMethod = await models.PaymentMethod.findByPk(paymentMethod.SourcePaymentMethodId);
  if (!sourcePaymentMethod) {
    throw new Error(`Gift Card source Payment Method unavailable`);
  }

  // finding the payment provider lib to execute the order
  const sourcePaymentMethodProvider = findPaymentMethodProvider(sourcePaymentMethod);

  let creditTransaction;
  try {
    // modifying original order to then process the order of the source payment method
    order.PaymentMethodId = sourcePaymentMethod.id;
    order.paymentMethod = sourcePaymentMethod;
    // gets the Credit transaction generated
    creditTransaction = await sourcePaymentMethodProvider.processOrder(order);
    if (order.SubscriptionId) {
      const subscription = await models.Subscription.findByPk(order.SubscriptionId);
      await subscription.update({ lastChargedAt: creditTransaction.clearedAt });
    }
  } finally {
    // undo modification of original order after processing the source payment method order
    await order.update({ PaymentMethodId: paymentMethod.id });
    order.PaymentMethodId = paymentMethod.id;
    order.paymentMethod = paymentMethod;
  }

  // gets the Debit transaction generated through the TransactionGroup field.
  const updatedTransactions = await models.Transaction.update(
    {
      PaymentMethodId: paymentMethod.id,
      UsingGiftCardFromCollectiveId: sourcePaymentMethod.CollectiveId,
    },
    {
      where: { TransactionGroup: creditTransaction.TransactionGroup, kind: ['CONTRIBUTION', 'PLATFORM_TIP'] },
      returning: true,
    },
  );
  // updating creditTransaction with latest data
  creditTransaction = updatedTransactions[1].filter(t => t.type === 'CREDIT' && t.kind === 'CONTRIBUTION')[0];
  return creditTransaction;
}

async function refundTransaction(transaction, user, reason, refundKind) {
  /* Create negative transactions for the received transaction */
  return await createRefundTransaction(transaction, 0, null, user, null, null, refundKind);
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
