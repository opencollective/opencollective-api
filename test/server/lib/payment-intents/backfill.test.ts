import { expect } from 'chai';
import { v4 as uuid } from 'uuid';

import ExpenseStatus from '../../../../server/constants/expense-status';
import OrderStatus from '../../../../server/constants/order-status';
import PaymentIntentStatus from '../../../../server/constants/payment-intent-status';
import PaymentIntentType from '../../../../server/constants/payment-intent-type';
import { TransactionKind } from '../../../../server/constants/transaction-kind';
import {
  backfillLedgerPhase,
  backfillPaymentIntentForOrderLedger,
  backfillPaymentIntentForPendingExpense,
  backfillPaymentIntentForPendingOrder,
} from '../../../../server/lib/payment-intents/backfill';
import models from '../../../../server/models';
import { fakeExpense, fakeOrder, fakeTransaction } from '../../../test-helpers/fake-data';
import {
  expectPaymentIntentForExpense,
  expectPaymentIntentForOrder,
  expectTransactionsLinkedToPaymentIntent,
} from '../../../test-helpers/payment-intent';

const clearPaymentIntentForOrder = async (orderId: number): Promise<void> => {
  await models.PaymentIntent.destroy({ where: { OrderId: orderId }, force: true });
  await models.Transaction.update({ PaymentIntentId: null }, { where: { OrderId: orderId } });
};

const clearPaymentIntentForExpense = async (expenseId: number): Promise<void> => {
  await models.PaymentIntent.destroy({ where: { ExpenseId: expenseId }, force: true });
  await models.Transaction.update({ PaymentIntentId: null }, { where: { ExpenseId: expenseId } });
};

describe('server/lib/payment-intents/backfill', () => {
  describe('backfillPaymentIntentForOrderLedger', () => {
    it('creates a PAID payment intent and links ledger transactions', async () => {
      const order = await fakeOrder({ status: OrderStatus.PAID }, { withTransactions: true });
      await clearPaymentIntentForOrder(order.id);

      const result = await backfillPaymentIntentForOrderLedger(order.id);
      expect(result).to.eq('processed');

      const paymentIntent = await expectPaymentIntentForOrder(order.id, {
        status: PaymentIntentStatus.PAID,
        type: PaymentIntentType.Contribution,
      });
      expect(paymentIntent.primaryTransactionGroup).to.exist;
      await expectTransactionsLinkedToPaymentIntent(paymentIntent.primaryTransactionGroup, paymentIntent.id);
    });

    it('groups charge and reversal under a single REVERSED payment intent', async () => {
      const order = await fakeOrder({ status: OrderStatus.REFUNDED }, { withTransactions: true });
      const refundGroup = uuid();

      await fakeTransaction({
        OrderId: order.id,
        type: 'CREDIT',
        kind: TransactionKind.CONTRIBUTION,
        isRefund: true,
        FromCollectiveId: order.CollectiveId,
        CollectiveId: order.FromCollectiveId,
        HostCollectiveId: order.transactions[0].HostCollectiveId,
        amount: order.totalAmount,
        TransactionGroup: refundGroup,
      });
      await fakeTransaction({
        OrderId: order.id,
        type: 'DEBIT',
        kind: TransactionKind.CONTRIBUTION,
        isRefund: true,
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: order.CollectiveId,
        HostCollectiveId: order.transactions[0].HostCollectiveId,
        amount: -order.totalAmount,
        TransactionGroup: refundGroup,
      });

      await clearPaymentIntentForOrder(order.id);

      const result = await backfillPaymentIntentForOrderLedger(order.id);
      expect(result).to.eq('processed');

      const paymentIntent = await expectPaymentIntentForOrder(order.id, {
        status: PaymentIntentStatus.REVERSED,
        type: PaymentIntentType.Contribution,
      });
      expect(paymentIntent.primaryTransactionGroup).to.exist;
      await expectTransactionsLinkedToPaymentIntent(paymentIntent.primaryTransactionGroup, paymentIntent.id);
      await expectTransactionsLinkedToPaymentIntent(refundGroup, paymentIntent.id);
    });

    it('is idempotent on a second run', async () => {
      const order = await fakeOrder({ status: OrderStatus.PAID }, { withTransactions: true });
      await clearPaymentIntentForOrder(order.id);

      expect(await backfillPaymentIntentForOrderLedger(order.id)).to.eq('processed');
      expect(await backfillPaymentIntentForOrderLedger(order.id)).to.eq('skipped');
    });
  });

  describe('backfillPaymentIntentForPendingOrder', () => {
    it('creates a PENDING payment intent for orders without ledger entries', async () => {
      const order = await fakeOrder({ status: OrderStatus.NEW });
      await clearPaymentIntentForOrder(order.id);

      const result = await backfillPaymentIntentForPendingOrder(order.id);
      expect(result).to.eq('processed');

      await expectPaymentIntentForOrder(order.id, {
        status: PaymentIntentStatus.PENDING,
        type: PaymentIntentType.Contribution,
        paidAt: null,
      });
    });
  });

  describe('backfillPaymentIntentForPendingExpense', () => {
    it('creates a PENDING payment intent for expenses without ledger entries', async () => {
      const expense = await fakeExpense({ status: ExpenseStatus.APPROVED });
      await clearPaymentIntentForExpense(expense.id);

      const result = await backfillPaymentIntentForPendingExpense(expense.id);
      expect(result).to.eq('processed');

      await expectPaymentIntentForExpense(expense.id, {
        status: PaymentIntentStatus.PENDING,
        type: PaymentIntentType.PaymentRequest,
        paidAt: null,
      });
    });
  });

  describe('backfillLedgerPhase', () => {
    it('processes only the targeted order ids', async () => {
      const order = await fakeOrder({ status: OrderStatus.PAID }, { withTransactions: true });
      const otherOrder = await fakeOrder({ status: OrderStatus.PAID }, { withTransactions: true });
      await clearPaymentIntentForOrder(order.id);
      await clearPaymentIntentForOrder(otherOrder.id);

      const stats = await backfillLedgerPhase({ orderIds: [order.id] });
      expect(stats.processed).to.eq(1);

      await expectPaymentIntentForOrder(order.id, { status: PaymentIntentStatus.PAID });
      const otherPaymentIntent = await models.PaymentIntent.findOne({ where: { OrderId: otherOrder.id } });
      expect(otherPaymentIntent).to.be.null;
    });
  });
});
