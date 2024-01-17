import { expect } from 'chai';
import moment from 'moment';
import { createSandbox } from 'sinon';

import ExpenseStatuses from '../../../server/constants/expense_status';
import OrderStatuses from '../../../server/constants/order_status';
import { TransactionTypes } from '../../../server/constants/transactions';
import {
  getBalances,
  getCurrentCollectiveBalances,
  getTotalMoneyManagedAmount,
  getYearlyBudgets,
  sumCollectivesTransactions,
} from '../../../server/lib/budget';
import * as libcurrency from '../../../server/lib/currency';
import { sequelize } from '../../../server/models';
import { fakeCollective, fakeExpense, fakeOrder, fakeTransaction } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/lib/budget', () => {
  before(resetTestDB);

  describe('getYearlyBudget', () => {
    it('returns 0 for collective without transactions', async () => {
      const collective = await fakeCollective();
      const yearlyBudgets = await getYearlyBudgets([collective.id]);
      expect(yearlyBudgets[collective.id].value).to.equal(0);
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
      await fakeOrder(
        { CollectiveId: collective.id, totalAmount: 1000, interval: null },
        { withSubscription: false, withTransactions: true },
      );

      // Cancelled subscriptions (count as one-time): $10 x 3 = $30
      const cancelledOrder = await fakeOrder(
        { totalAmount: 1000, interval: 'month', status: OrderStatuses.CANCELLED },
        { withSubscription: true },
      );
      await cancelledOrder.Subscription.deactivate();
      const cancelledOrderTransactionValues = {
        type: TransactionTypes.CREDIT,
        kind: 'CONTRIBUTION',
        CollectiveId: collective.id,
        OrderId: cancelledOrder.id,
        amount: cancelledOrder.totalAmount,
      } as const;

      await fakeTransaction(cancelledOrderTransactionValues, { createDoubleEntry: true });
      await fakeTransaction(cancelledOrderTransactionValues, { createDoubleEntry: true });
      await fakeTransaction(cancelledOrderTransactionValues, { createDoubleEntry: true });

      // Total should be the sum of all the above:
      // - Active Contributions: $150.00 + $45.00 = 195.00
      // - Past Contributions: $10.00 + $30.00
      // = Total: $235.00
      const yearlyBudgets = await getYearlyBudgets([collective.id]);
      expect(yearlyBudgets[collective.id].value).to.equal(235e2);
    });
  });

  describe('sumCollectivesTransactions', () => {
    it('sums correctly', async () => {
      const collective = await fakeCollective();

      await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: 20e2 }, { createDoubleEntry: true });

      await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: 30e2 }, { createDoubleEntry: true });

      const txs = await sumCollectivesTransactions([collective.id], {
        column: 'netAmountInHostCurrency',
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
            column: 'netAmountInHostCurrency',
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

  describe('getTotalMoneyManaged', () => {
    it('returns 0 for collective without transactions', async () => {
      const host = await fakeCollective();
      const totalMoneyManaged = await getTotalMoneyManagedAmount(host);
      expect(totalMoneyManaged.value).to.equal(0);
    });

    it('returns the sum of all transactions for one collective', async () => {
      const host = await fakeCollective();
      const collective = await fakeCollective({ HostCollectiveId: host.id, approvedAt: new Date() });
      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: collective.id, HostCollectiveId: host.id, amount: 20e2 },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: collective.id, HostCollectiveId: host.id, amount: 30e2 },
        { createDoubleEntry: true },
      );
      const totalMoneyManaged = await getTotalMoneyManagedAmount(host);
      expect(totalMoneyManaged.value).to.equal(50e2);
    });

    it('returns the sum of all transactions for multiple collectives', async () => {
      const host = await fakeCollective();
      const collective1 = await fakeCollective({ HostCollectiveId: host.id, approvedAt: new Date() });
      const collective2 = await fakeCollective({ HostCollectiveId: host.id, approvedAt: new Date() });
      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: collective1.id, HostCollectiveId: host.id, amount: 20e2 },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: collective1.id, HostCollectiveId: host.id, amount: 30e2 },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: collective2.id, HostCollectiveId: host.id, amount: 70e2 },
        { createDoubleEntry: true },
      );
      const totalMoneyManaged = await getTotalMoneyManagedAmount(host);
      expect(totalMoneyManaged.value).to.equal(120e2);
    });
  });

  describe('getCurrentCollectiveBalances', () => {
    let collective, otherCollective, sandbox;

    beforeEach(async () => {
      await resetTestDB();
      collective = await fakeCollective();
      otherCollective = await fakeCollective();
    });

    before(async () => {
      sandbox = createSandbox();

      sandbox
        .stub(libcurrency, 'getFxRate')
        .withArgs('BRL', 'USD')
        .resolves(1 / 1.1)
        .withArgs('USD', 'BRL')
        .resolves(1.1)
        .withArgs('USD', 'USD')
        .resolves(1)
        .withArgs('BRL', 'BRL')
        .resolves(1);
    });

    after(() => {
      sandbox.restore();
    });

    async function createBalanceData(refreshView) {
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          HostCollectiveId: collective.host.id,
          amount: 20e2,
          currency: 'USD',
          createdAt: new Date(Date.now() - 1000 * 60 * 10),
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
          createdAt: new Date(Date.now() - 1000 * 60 * 9),
        },
        { createDoubleEntry: true },
      );

      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: otherCollective.id,
          HostCollectiveId: otherCollective.host.id,
          amount: 50e2,
          currency: 'USD',
          createdAt: new Date(Date.now() - 1000 * 60 * 8),
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: otherCollective.id,
          HostCollectiveId: otherCollective.host.id,
          amount: 60e2,
          currency: 'USD',
          createdAt: new Date(Date.now() - 1000 * 60 * 7),
        },
        { createDoubleEntry: true },
      );

      if (refreshView) {
        await sequelize.query('REFRESH MATERIALIZED VIEW "TransactionBalances"');
        await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveBalanceCheckpoint"`);
      }

      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          HostCollectiveId: collective.host.id,
          amount: 40e2,
          currency: 'USD',
          createdAt: new Date(Date.now() - 1000 * 60 * 6),
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          HostCollectiveId: collective.host.id,
          amount: 50e2,
          currency: 'USD',
          isDisputed: true,
          createdAt: new Date(Date.now() - 1000 * 60 * 5),
        },
        { createDoubleEntry: true },
      );

      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: otherCollective.id,
          HostCollectiveId: otherCollective.host.id,
          amount: 10e2,
          currency: 'USD',
          createdAt: new Date(Date.now() - 1000 * 60 * 4),
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: otherCollective.id,
          HostCollectiveId: otherCollective.host.id,
          amount: 10e2,
          currency: 'USD',
          createdAt: new Date(Date.now() - 1000 * 60 * 3),
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
    }

    it('sums correctly with materialized view and new transactions', async () => {
      await createBalanceData(true);

      const balances = await getCurrentCollectiveBalances([collective.id, otherCollective.id], {
        withBlockedFunds: true,
      });
      expect(balances[collective.id].value).to.eq(7091);
      expect(balances[otherCollective.id].value).to.eq(130e2);
    });

    it('sums correctly without materialized view', async () => {
      await createBalanceData(false);

      const fastBalances = await getCurrentCollectiveBalances([collective.id, otherCollective.id], {
        withBlockedFunds: true,
      });
      expect(fastBalances).to.be.empty;

      const balances = await getBalances([collective.id, otherCollective.id], {
        withBlockedFunds: true,
      });

      expect(balances[collective.id].value).to.eq(7091);
      expect(balances[otherCollective.id].value).to.eq(130e2);
    });

    it('sums correctly when not excluding blocked balances', async () => {
      await createBalanceData(true);

      const balances = await getCurrentCollectiveBalances([collective.id, otherCollective.id], {
        withBlockedFunds: false,
      });
      expect(balances[collective.id].value).to.eq(140e2);
      expect(balances[otherCollective.id].value).to.eq(130e2);
    });
  });
});
