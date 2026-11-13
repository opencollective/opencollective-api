import { expect } from 'chai';

import ExpenseStatus from '../../../../server/constants/expense-status';
import OrderStatus from '../../../../server/constants/order-status';
import PaymentIntentStatus from '../../../../server/constants/payment-intent-status';
import { TransactionKind } from '../../../../server/constants/transaction-kind';
import { resolveSharedParentCollectiveId } from '../../../../server/lib/payment-intents/sync';
import { createRefundTransaction } from '../../../../server/lib/payments';
import { createTransactionsFromPaidExpense } from '../../../../server/lib/transactions';
import models from '../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeHost,
  fakeOrder,
  fakeProject,
  fakeTransaction,
  fakeUser,
} from '../../../test-helpers/fake-data';

describe('server/lib/payment-intents/sync', () => {
  describe('resolveSharedParentCollectiveId', () => {
    it('returns null when payer or payee is missing', async () => {
      const collective = await fakeCollective();

      expect(await resolveSharedParentCollectiveId(null, collective.id)).to.be.null;
      expect(await resolveSharedParentCollectiveId(collective.id, null)).to.be.null;
      expect(await resolveSharedParentCollectiveId(null, null)).to.be.null;
    });

    it('returns the collective id when payer and payee are the same', async () => {
      const collective = await fakeCollective();

      expect(await resolveSharedParentCollectiveId(collective.id, collective.id)).to.eq(collective.id);
    });

    it('returns the parent collective id when payer is parent of payee', async () => {
      const parent = await fakeCollective();
      const child = await fakeProject({ ParentCollectiveId: parent.id });

      expect(await resolveSharedParentCollectiveId(parent.id, child.id)).to.eq(parent.id);
    });

    it('returns the parent collective id when payee is parent of payer', async () => {
      const parent = await fakeCollective();
      const child = await fakeProject({ ParentCollectiveId: parent.id });

      expect(await resolveSharedParentCollectiveId(child.id, parent.id)).to.eq(parent.id);
    });

    it('returns the shared parent collective id when payer and payee are siblings', async () => {
      const parent = await fakeCollective();
      const payer = await fakeProject({ ParentCollectiveId: parent.id });
      const payee = await fakeProject({ ParentCollectiveId: parent.id });

      expect(await resolveSharedParentCollectiveId(payer.id, payee.id)).to.eq(parent.id);
    });

    it('returns null for unrelated collectives', async () => {
      const payer = await fakeCollective();
      const payee = await fakeCollective();

      expect(await resolveSharedParentCollectiveId(payer.id, payee.id)).to.be.null;
    });

    it('returns null when a collective id does not exist', async () => {
      const collective = await fakeCollective();

      expect(await resolveSharedParentCollectiveId(collective.id, 999999999)).to.be.null;
      expect(await resolveSharedParentCollectiveId(999999999, collective.id)).to.be.null;
    });
  });

  describe('status after refunds', () => {
    const setupRecurringOrder = async () => {
      const host = await fakeActiveHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const user = await fakeUser();
      const order = await fakeOrder({
        CollectiveId: collective.id,
        FromCollectiveId: user.CollectiveId,
        CreatedByUserId: user.id,
        status: OrderStatus.ACTIVE,
        totalAmount: 1000,
      });
      const charge = () =>
        fakeTransaction(
          {
            kind: TransactionKind.CONTRIBUTION,
            amount: 1000,
            OrderId: order.id,
            CollectiveId: collective.id,
            FromCollectiveId: user.CollectiveId,
            HostCollectiveId: host.id,
            CreatedByUserId: user.id,
          },
          { createDoubleEntry: true },
        );
      const getIntent = () => models.PaymentIntent.findOne({ where: { OrderId: order.id } });
      return { user, order, charge, getIntent };
    };

    it('keeps a recurring order PAID when a charge other than the primary one is refunded', async () => {
      const { user, charge, getIntent } = await setupRecurringOrder();
      const charge1 = await charge();
      const charge2 = await charge();
      expect((await getIntent()).primaryTransactionGroup).to.eq(charge2.TransactionGroup);

      await createRefundTransaction(charge1, 0, null, user);
      let intent = await getIntent();
      expect(intent.primaryTransactionGroup).to.eq(charge2.TransactionGroup);
      expect(intent.status).to.eq(PaymentIntentStatus.PAID);

      const charge3 = await charge();
      intent = await getIntent();
      expect(intent.primaryTransactionGroup).to.eq(charge3.TransactionGroup);
      expect(intent.status).to.eq(PaymentIntentStatus.PAID);
    });

    it('marks a recurring order REVERSED when its primary charge is refunded, then PAID on the next charge', async () => {
      const { user, charge, getIntent } = await setupRecurringOrder();
      const charge1 = await charge();

      await createRefundTransaction(charge1, 0, null, user);
      expect((await getIntent()).status).to.eq(PaymentIntentStatus.REVERSED);

      const charge2 = await charge();
      const intent = await getIntent();
      expect(intent.primaryTransactionGroup).to.eq(charge2.TransactionGroup);
      expect(intent.status).to.eq(PaymentIntentStatus.PAID);
    });

    it('marks an expense PAID again with the new paidAt when it is marked as unpaid and paid again', async () => {
      const host = await fakeActiveHost({ currency: 'USD' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      const user = await fakeUser();
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        status: ExpenseStatus.APPROVED,
        amount: 1000,
        currency: 'USD',
      });
      const getIntent = () => models.PaymentIntent.findOne({ where: { ExpenseId: expense.id } });

      await createTransactionsFromPaidExpense(host, expense, undefined, 1, {
        clearedAt: new Date('2020-01-01T00:00:00Z'),
      });
      await expense.update({ status: ExpenseStatus.PAID });
      let intent = await getIntent();
      expect(intent.status).to.eq(PaymentIntentStatus.PAID);
      const firstGroup = intent.primaryTransactionGroup;

      // Mark as unpaid
      const debit = await models.Transaction.findOne({
        where: { ExpenseId: expense.id, RefundTransactionId: null, kind: TransactionKind.EXPENSE, isRefund: false },
      });
      await createRefundTransaction(debit, 0, null, user);
      await expense.update({ status: ExpenseStatus.APPROVED });
      expect((await getIntent()).status).to.eq(PaymentIntentStatus.REVERSED);

      // Pay again
      const secondPaidAt = new Date('2021-06-01T00:00:00Z');
      await createTransactionsFromPaidExpense(host, expense, undefined, 1, { clearedAt: secondPaidAt });
      await expense.update({ status: ExpenseStatus.PAID });

      intent = await getIntent();
      expect(intent.primaryTransactionGroup).to.not.eq(firstGroup);
      expect(intent.status).to.eq(PaymentIntentStatus.PAID);
      expect(intent.paidAt.toISOString()).to.eq(secondPaidAt.toISOString());
    });
  });

  describe('host after a lifecycle sync', () => {
    it('keeps the payee host when a cross-host contribution order changes status', async () => {
      const payerHost = await fakeHost();
      const payeeHost = await fakeHost();
      const payer = await fakeCollective({ HostCollectiveId: payerHost.id });
      const payee = await fakeCollective({ HostCollectiveId: payeeHost.id });
      const order = await fakeOrder({
        FromCollectiveId: payer.id,
        CollectiveId: payee.id,
        status: OrderStatus.NEW,
        totalAmount: 1000,
      });

      await fakeTransaction(
        {
          kind: TransactionKind.CONTRIBUTION,
          amount: 1000,
          FromCollectiveId: payer.id,
          CollectiveId: payee.id,
          HostCollectiveId: payeeHost.id,
          OrderId: order.id,
        },
        { createDoubleEntry: true },
      );
      await order.update({ status: OrderStatus.ACTIVE });
      const getIntent = () => models.PaymentIntent.findOne({ where: { OrderId: order.id } });
      expect((await getIntent()).HostCollectiveId).to.eq(payeeHost.id);

      await order.update({ status: OrderStatus.CANCELLED });
      expect((await getIntent()).HostCollectiveId).to.eq(payeeHost.id);
    });
  });
});
