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
  runBackfill,
} from '../../../../server/lib/payment-intents/backfill';
import models from '../../../../server/models';
import {
  fakeCollective,
  fakeExpense,
  fakeHost,
  fakeOrder,
  fakeTransaction,
  fakeUser,
} from '../../../test-helpers/fake-data';
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

/** Records a contribution the way the app does: a CREDIT passed to createDoubleEntry, which writes the DEBIT first. */
const recordContribution = async (order, collective) => {
  const credit = await fakeTransaction(
    {
      OrderId: order.id,
      type: 'CREDIT',
      kind: TransactionKind.CONTRIBUTION,
      FromCollectiveId: order.FromCollectiveId,
      CollectiveId: order.CollectiveId,
      HostCollectiveId: collective.HostCollectiveId,
      amount: 5000,
    },
    { createDoubleEntry: true },
  );
  const transactions = await models.Transaction.findAll({ where: { OrderId: order.id }, order: [['id', 'ASC']] });
  expect(transactions.map(t => t.type)).to.deep.eq(['DEBIT', 'CREDIT']);
  return { credit, debit: transactions[0] };
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

    it('uses the host recorded on the CREDIT, even if the collective changed host since', async () => {
      const host1 = await fakeHost();
      const host2 = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host1.id });
      const user = await fakeUser();
      const order = await fakeOrder({
        status: OrderStatus.PAID,
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
      });
      const { credit, debit } = await recordContribution(order, collective);
      expect(credit.HostCollectiveId).to.eq(host1.id);
      expect(debit.HostCollectiveId).to.be.null;

      await collective.update({ HostCollectiveId: host2.id });
      await clearPaymentIntentForOrder(order.id);

      expect(await backfillPaymentIntentForOrderLedger(order.id)).to.eq('processed');
      const paymentIntent = await expectPaymentIntentForOrder(order.id, { status: PaymentIntentStatus.PAID });
      expect(paymentIntent.HostCollectiveId).to.eq(host1.id);
    });

    it('uses the receiving host when the contributor is hosted by another host', async () => {
      const host1 = await fakeHost();
      const host2 = await fakeHost();
      const payee = await fakeCollective({ HostCollectiveId: host1.id });
      const payer = await fakeCollective({ HostCollectiveId: host2.id });
      const order = await fakeOrder({ status: OrderStatus.PAID, FromCollectiveId: payer.id, CollectiveId: payee.id });
      const { credit, debit } = await recordContribution(order, payee);
      expect(credit.HostCollectiveId).to.eq(host1.id);
      expect(debit.HostCollectiveId).to.eq(host2.id);

      await clearPaymentIntentForOrder(order.id);

      expect(await backfillPaymentIntentForOrderLedger(order.id)).to.eq('processed');
      const paymentIntent = await expectPaymentIntentForOrder(order.id, { status: PaymentIntentStatus.PAID });
      expect(paymentIntent.HostCollectiveId).to.eq(host1.id);
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

    it('resuming with afterId = lastId backfills expenses with ids below the last processed order', async () => {
      const expense = await fakeExpense({ status: ExpenseStatus.PAID });
      await fakeTransaction({
        ExpenseId: expense.id,
        type: 'DEBIT',
        kind: TransactionKind.EXPENSE,
        CollectiveId: expense.CollectiveId,
        FromCollectiveId: expense.FromCollectiveId,
        amount: -expense.amount,
      });
      const orders = [];
      while (orders.length < 2 || orders[0].id <= expense.id) {
        orders.splice(0, orders.length - 1);
        orders.push(await fakeOrder({ status: OrderStatus.PAID }, { withTransactions: true }));
      }
      await clearPaymentIntentForExpense(expense.id);
      await Promise.all(orders.map(order => clearPaymentIntentForOrder(order.id)));

      // Resume the way an operator would, with --limit 1 --after-id <lastId>
      let afterId = 0;
      for (let i = 0; i < 100; i++) {
        const stats = await backfillLedgerPhase({ limit: 1, afterId });
        if (stats.processed + stats.skipped + stats.errors === 0) {
          break;
        }
        afterId = stats.lastId;
      }

      for (const order of orders) {
        await expectPaymentIntentForOrder(order.id, { status: PaymentIntentStatus.PAID });
      }
      await expectPaymentIntentForExpense(expense.id, {});
    });
  });

  describe('runBackfill', () => {
    it('with orderIds, does not touch unrelated pending expenses', async () => {
      const order = await fakeOrder({ status: OrderStatus.PENDING });
      const unrelatedExpense = await fakeExpense({ status: ExpenseStatus.APPROVED });
      await clearPaymentIntentForOrder(order.id);
      await clearPaymentIntentForExpense(unrelatedExpense.id);

      const results = await runBackfill('all', { orderIds: [order.id] });

      expect(await models.PaymentIntent.count({ where: { OrderId: order.id } })).to.eq(1);
      expect(await models.PaymentIntent.count({ where: { ExpenseId: unrelatedExpense.id } })).to.eq(0);
      expect(results['pending-expenses'].processed).to.eq(0);
    });

    it('with expenseIds, does not touch unrelated pending orders', async () => {
      const expense = await fakeExpense({ status: ExpenseStatus.APPROVED });
      const unrelatedOrder = await fakeOrder({ status: OrderStatus.PENDING });
      await clearPaymentIntentForExpense(expense.id);
      await clearPaymentIntentForOrder(unrelatedOrder.id);

      const results = await runBackfill('all', { expenseIds: [expense.id] });

      expect(await models.PaymentIntent.count({ where: { ExpenseId: expense.id } })).to.eq(1);
      expect(await models.PaymentIntent.count({ where: { OrderId: unrelatedOrder.id } })).to.eq(0);
      expect(results['pending-orders'].processed).to.eq(0);
    });
  });
});
