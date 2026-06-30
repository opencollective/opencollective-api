import { expect } from 'chai';
import moment from 'moment';

import PaymentIntentStatus from '../../server/constants/payment-intent-status';
import PaymentIntentType from '../../server/constants/payment-intent-type';
import models, { Expense, Order, Transaction } from '../../server/models';
import PaymentIntent from '../../server/models/PaymentIntent';

type PaymentIntentExpectation = {
  status?: PaymentIntentStatus;
  type?: PaymentIntentType;
  primaryTransactionGroup?: string | null;
  paidAt?: Date | null;
};

const getPaymentIntentForOrder = async (order: Order | number): Promise<PaymentIntent | null> => {
  const orderId = typeof order === 'number' ? order : order.id;
  return models.PaymentIntent.findOne({ where: { OrderId: orderId } });
};

const getPaymentIntentForExpense = async (expense: Expense | number): Promise<PaymentIntent | null> => {
  const expenseId = typeof expense === 'number' ? expense : expense.id;
  return models.PaymentIntent.findOne({ where: { ExpenseId: expenseId } });
};

export const expectPaymentIntentForOrder = async (
  order: Order | number,
  expectation: PaymentIntentExpectation,
): Promise<PaymentIntent> => {
  const paymentIntent = await getPaymentIntentForOrder(order);
  expect(paymentIntent, 'Expected a PaymentIntent for order').to.exist;
  assertPaymentIntent(paymentIntent, expectation);
  return paymentIntent;
};

export const expectPaymentIntentForExpense = async (
  expense: Expense | number,
  expectation: PaymentIntentExpectation,
): Promise<PaymentIntent> => {
  const paymentIntent = await getPaymentIntentForExpense(expense);
  expect(paymentIntent, 'Expected a PaymentIntent for expense').to.exist;
  assertPaymentIntent(paymentIntent, expectation);
  return paymentIntent;
};

const assertPaymentIntent = (paymentIntent: PaymentIntent, expectation: PaymentIntentExpectation): void => {
  if (expectation.status !== undefined) {
    expect(paymentIntent.status).to.eq(expectation.status);
  }
  if (expectation.type !== undefined) {
    expect(paymentIntent.type).to.eq(expectation.type);
  }
  if (expectation.primaryTransactionGroup !== undefined) {
    expect(paymentIntent.primaryTransactionGroup).to.eq(expectation.primaryTransactionGroup);
  }
  if (expectation.paidAt !== undefined) {
    if (expectation.paidAt === null) {
      expect(paymentIntent.paidAt).to.be.null;
    } else if (typeof expectation.paidAt === 'boolean') {
      expect(paymentIntent.paidAt).to.exist;
    } else {
      expect(moment(paymentIntent.paidAt).isSame(expectation.paidAt)).to.be.true;
    }
  }
};

export const expectPaymentIntentSoftDeletedForExpense = async (expense: Expense | number): Promise<void> => {
  const expenseId = typeof expense === 'number' ? expense : expense.id;
  const paymentIntent = await models.PaymentIntent.findOne({
    where: { ExpenseId: expenseId },
    paranoid: false,
  });
  expect(paymentIntent, 'Expected a PaymentIntent for expense').to.exist;
  expect(paymentIntent.deletedAt).to.exist;
};

export const expectTransactionsLinkedToPaymentIntent = async (
  transactionGroup: string,
  paymentIntentId: number,
): Promise<Transaction[]> => {
  const transactions = await models.Transaction.findAll({
    where: { TransactionGroup: transactionGroup },
  });
  expect(transactions.length).to.be.greaterThan(0);
  for (const transaction of transactions) {
    expect(transaction.PaymentIntentId).to.eq(paymentIntentId);
  }
  return transactions;
};
