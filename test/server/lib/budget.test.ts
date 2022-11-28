import { expect } from 'chai';
import moment from 'moment';

import ExpenseStatuses from '../../../server/constants/expense_status';
import { getCurrentBalance, getYearlyIncome, sumCollectivesTransactions } from '../../../server/lib/budget';
import { sequelize } from '../../../server/models';
import { fakeCollective, fakeExpense, fakeOrder, fakeTransaction } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/lib/budget', () => {
  before(resetTestDB);

  describe('getYearlyIncome', () => {
    it('returns 0 for collective without transactions', async () => {
      const collective = await fakeCollective();
      expect(await getYearlyIncome(collective)).to.equal(0);
    });

    it('calculates the budget', async () => {
      const collective = await fakeCollective();

      // Deleted transactions should be ignored
      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: collective.id, amount: 10e2, deletedAt: new Date() },
        { createDoubleEntry: true },
      );

      // One-time transactions older than 12 months should be ignored
      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: collective.id, amount: 10e2, createdAt: new Date('2020-01-01') },
        { createDoubleEntry: true },
      );

      // Monthly contribs: ($7.50/month * 12 = $90) + ($5/month * 12 = $60) = $150
      await fakeOrder(
        { CollectiveId: collective.id, totalAmount: 750, interval: 'month' },
        { withSubscription: true, withTransactions: true },
      );
      await fakeOrder(
        { CollectiveId: collective.id, totalAmount: 500, interval: 'month' },
        { withSubscription: true, withTransactions: true },
      );

      // Yearly contribs: $15/year + $30/year = $45
      await fakeOrder(
        { CollectiveId: collective.id, totalAmount: 1500, interval: 'year' },
        { withSubscription: true, withTransactions: true },
      );
      await fakeOrder(
        { CollectiveId: collective.id, totalAmount: 3000, interval: 'year' },
        { withSubscription: true, withTransactions: true },
      );

      // Recent one-time: $10
      await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: 10e2 }, { createDoubleEntry: true });

      // Cancelled subscriptions (count as one-time): $10 x 3 = $30
      const cancelledOrder = await fakeOrder(
        { totalAmount: 1000, interval: 'month', status: 'CANCELLED' },
        { withSubscription: true },
      );
      await cancelledOrder.Subscription.deactivate();
      const cancelledOrderTransactionValues = {
        type: 'CREDIT',
        CollectiveId: collective.id,
        OrderId: cancelledOrder.id,
        amount: cancelledOrder.totalAmount,
      };

      await fakeTransaction(cancelledOrderTransactionValues, { createDoubleEntry: true });
      await fakeTransaction(cancelledOrderTransactionValues, { createDoubleEntry: true });
      await fakeTransaction(cancelledOrderTransactionValues, { createDoubleEntry: true });

      // Total should be the sum of all the above
      expect(await getYearlyIncome(collective)).to.equal(235e2);
    });
  });

  describe('sumCollectivesTransactions', () => {
    it('sums correctly', async () => {
      const collective = await fakeCollective();

      await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: 20e2 }, { createDoubleEntry: true });

      await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: 30e2 }, { createDoubleEntry: true });

      const txs = await sumCollectivesTransactions([collective.id], {
        column: 'netAmountInCollectiveCurrency',
        startDate: moment().subtract(1, 'day'),
        endDate: moment(),
        kind: null,
      });
      const sum = txs[collective.id];
      expect(sum.value).to.eq(50e2);
    });

    describe('when blocked funds are excluded', () => {
      describe('when there are disputed Transactions', () => {
        it('returns the unblocked funds sum', async () => {
          const collective = await fakeCollective();

          await fakeTransaction(
            { type: 'CREDIT', CollectiveId: collective.id, amount: 20e2 },
            { createDoubleEntry: true },
          );

          await fakeTransaction(
            { type: 'CREDIT', CollectiveId: collective.id, amount: 30e2 },
            { createDoubleEntry: true },
          );

          await fakeTransaction(
            { type: 'CREDIT', CollectiveId: collective.id, amount: 40e2, isDisputed: true },
            { createDoubleEntry: true },
          );

          const txs = await sumCollectivesTransactions([collective.id], {
            column: 'netAmountInCollectiveCurrency',
            startDate: moment().subtract(1, 'day'),
            endDate: moment(),
            kind: null,
            withBlockedFunds: true,
            excludeRefunds: false,
          });
          const sum = txs[collective.id];
          expect(sum.value).to.eq(50e2);
        });
      });
    });
  });

  describe('getCurrentBalance', () => {
    let collective;

    beforeEach(async () => {
      await resetTestDB();
      collective = await fakeCollective();
    });

    it('sums correctly with materialized view and new transactions', async () => {
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          HostCollectiveId: collective.host.id,
          amount: 20e2,
          currency: 'USD',
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          HostCollectiveId: collective.host.id,
          amount: 30e2,
          currency: 'USD',
        },
        { createDoubleEntry: true },
      );
      await sequelize.query('REFRESH MATERIALIZED VIEW "CollectiveBalanceCheckpoint"');
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          HostCollectiveId: collective.host.id,
          amount: 40e2,
          currency: 'USD',
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          amount: 50e2,
          currency: 'USD',
          HostCollectiveId: collective.host.id,
          isDisputed: true,
        },
        { createDoubleEntry: true },
      );

      await fakeExpense({
        CollectiveId: collective.id,
        HostCollectiveId: collective.host.id,
        amount: 10e2,
        currency: 'USD',
        status: ExpenseStatuses.PROCESSING,
      });

      await fakeExpense({
        CollectiveId: collective.id,
        HostCollectiveId: collective.host.id,
        amount: 10e2,
        currency: 'BRL',
        status: ExpenseStatuses.PROCESSING,
      });

      const balance = await getCurrentBalance(collective.id, collective.HostCollectiveId, collective.host.currency);
      expect(balance).to.eq(69e2);
    });

    it('sums correctly without materialized view', async () => {
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          HostCollectiveId: collective.host.id,
          amount: 20e2,
          currency: 'USD',
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          HostCollectiveId: collective.host.id,
          amount: 30e2,
          currency: 'USD',
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          HostCollectiveId: collective.host.id,
          amount: 40e2,
          currency: 'USD',
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          amount: 50e2,
          currency: 'USD',
          HostCollectiveId: collective.host.id,
          isDisputed: true,
        },
        { createDoubleEntry: true },
      );

      await fakeExpense({
        CollectiveId: collective.id,
        HostCollectiveId: collective.host.id,
        amount: 10e2,
        currency: 'USD',
        status: ExpenseStatuses.PROCESSING,
      });

      await fakeExpense({
        CollectiveId: collective.id,
        HostCollectiveId: collective.host.id,
        amount: 10e2,
        currency: 'BRL',
        status: ExpenseStatuses.PROCESSING,
      });

      const balance = await getCurrentBalance(collective.id, collective.HostCollectiveId, collective.host.currency);
      expect(balance).to.eq(69e2);
    });
  });
});
