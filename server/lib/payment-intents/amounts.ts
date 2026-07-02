import { SupportedCurrency } from '../../constants/currencies';
import PaymentIntentStatus from '../../constants/payment-intent-status';
import models from '../../models';
import Expense from '../../models/Expense';
import Order from '../../models/Order';
import PaymentIntent from '../../models/PaymentIntent';
import Transaction from '../../models/Transaction';

export type PaymentIntentAmountFields = {
  value: number;
  currency: SupportedCurrency;
} | null;

type ComputePaymentIntentAmountOptions = {
  net?: boolean;
  transactions?: Transaction[];
  order?: Order | null;
  expense?: Expense | null;
  payerCurrency?: SupportedCurrency | null;
  payeeCurrency?: SupportedCurrency | null;
};

const sumTransactionAmounts = (
  transactions: Transaction[],
  type: 'DEBIT' | 'CREDIT',
  collectiveId: number,
  net: boolean,
): number => {
  return transactions
    .filter(transaction => transaction.type === type && transaction.CollectiveId === collectiveId)
    .reduce((sum, transaction) => {
      const amount = net ? transaction.netAmountInCollectiveCurrency : transaction.amount;
      return sum + Math.abs(amount);
    }, 0);
};

const getPendingOrderAmount = (order: Order): PaymentIntentAmountFields => ({
  value: order.totalAmount,
  currency: order.currency,
});

const getPendingExpenseAmount = (expense: Expense): PaymentIntentAmountFields => ({
  value: expense.amount,
  currency: expense.currency,
});

export const computePaymentIntentAmountPledged = async (
  paymentIntent: PaymentIntent,
  options: Pick<ComputePaymentIntentAmountOptions, 'order' | 'expense'> = {},
): Promise<PaymentIntentAmountFields> => {
  const order = options.order ?? (paymentIntent.OrderId ? await models.Order.findByPk(paymentIntent.OrderId) : null);
  if (order) {
    return getPendingOrderAmount(order);
  }

  const expense =
    options.expense ?? (paymentIntent.ExpenseId ? await models.Expense.findByPk(paymentIntent.ExpenseId) : null);
  if (expense) {
    return getPendingExpenseAmount(expense);
  }

  return null;
};

export const computePaymentIntentAmountSent = async (
  paymentIntent: PaymentIntent,
  options: ComputePaymentIntentAmountOptions = {},
): Promise<PaymentIntentAmountFields> => {
  if (!paymentIntent.PayerCollectiveId) {
    return null;
  }

  const net = options.net ?? false;
  const transactions =
    options.transactions ?? (await models.Transaction.findAll({ where: { PaymentIntentId: paymentIntent.id } }));

  if (transactions.length > 0) {
    const payerCurrency =
      options.payerCurrency ??
      (await models.Collective.findByPk(paymentIntent.PayerCollectiveId, { attributes: ['currency'] }))?.currency;

    if (!payerCurrency) {
      return null;
    }

    const value = sumTransactionAmounts(transactions, 'DEBIT', paymentIntent.PayerCollectiveId, net);
    return { value, currency: payerCurrency };
  }

  if (paymentIntent.status === PaymentIntentStatus.PENDING) {
    const order = options.order ?? (paymentIntent.OrderId ? await models.Order.findByPk(paymentIntent.OrderId) : null);
    if (order) {
      return getPendingOrderAmount(order);
    }
  }

  return null;
};

export const computePaymentIntentAmountReceived = async (
  paymentIntent: PaymentIntent,
  options: ComputePaymentIntentAmountOptions = {},
): Promise<PaymentIntentAmountFields> => {
  if (!paymentIntent.PayeeCollectiveId) {
    return null;
  }

  const net = options.net ?? false;
  const transactions =
    options.transactions ?? (await models.Transaction.findAll({ where: { PaymentIntentId: paymentIntent.id } }));

  if (transactions.length > 0) {
    const payeeCurrency =
      options.payeeCurrency ??
      (await models.Collective.findByPk(paymentIntent.PayeeCollectiveId, { attributes: ['currency'] }))?.currency;

    if (!payeeCurrency) {
      return null;
    }

    const value = sumTransactionAmounts(transactions, 'CREDIT', paymentIntent.PayeeCollectiveId, net);
    return { value, currency: payeeCurrency };
  }

  if (paymentIntent.status === PaymentIntentStatus.PENDING) {
    const order = options.order ?? (paymentIntent.OrderId ? await models.Order.findByPk(paymentIntent.OrderId) : null);
    if (order) {
      return getPendingOrderAmount(order);
    }

    const expense =
      options.expense ?? (paymentIntent.ExpenseId ? await models.Expense.findByPk(paymentIntent.ExpenseId) : null);
    if (expense) {
      return getPendingExpenseAmount(expense);
    }
  }

  return null;
};
