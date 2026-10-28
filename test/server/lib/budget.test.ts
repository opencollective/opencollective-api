import { expect } from 'chai';
import moment from 'moment';
import { createSandbox } from 'sinon';

import { CollectiveType } from '../../../server/constants/collectives';
import ExpenseStatuses from '../../../server/constants/expense-status';
import OrderStatuses from '../../../server/constants/order-status';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../server/constants/transactions';
import {
  getBalances,
  getBalanceTimeSeries,
  getBlockedContributionsCount,
  getContributionsAndContributorsCount,
  getCurrentCollectiveBalances,
  getCurrentCollectiveTransactionStats,
  getHistoricalCollectiveBalances,
  getSumCollectivesAmountSpent,
  getTotalAmountPaidExpenses,
  getTotalAmountReceivedAmount,
  getTotalAmountReceivedTimeSeries,
  getTotalAmountSpentAmount,
  getTotalAmountSpentTimeSeries,
  getTotalMoneyManagedAmount,
  getYearlyBudgets,
  sumCollectivesTransactions,
} from '../../../server/lib/budget';
import * as libcurrency from '../../../server/lib/currency';
import { sequelize } from '../../../server/models';
import { fakeCollective, fakeExpense, fakeOrder, fakeTransaction, fakeUser } from '../../test-helpers/fake-data';
import { makeRequest, resetTestDB } from '../../utils';

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
        kind: TransactionKind.CONTRIBUTION,
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
        startDate: moment().subtract(1, 'day').toDate(),
        endDate: moment().toDate(),
        kind: null,
      });
      const sum = txs[collective.id];
      expect(sum['value']).to.eq(50e2);
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
          expect(sum['value']).to.eq(50e2);
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

  describe('getHistoricalCollectiveBalances', () => {
    let collective, sandbox;

    beforeEach(async () => {
      await resetTestDB();
      collective = await fakeCollective();
    });

    before(async () => {
      sandbox = createSandbox();
      sandbox.stub(libcurrency, 'getFxRate').withArgs('USD', 'USD').resolves(1);
    });

    after(() => {
      sandbox.restore();
    });

    it('returns balance at a specific point in time using materialized view', async () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 1000 * 60 * 60);
      const twoHoursAgo = new Date(now.getTime() - 1000 * 60 * 60 * 2);
      const threeHoursAgo = new Date(now.getTime() - 1000 * 60 * 60 * 3);

      // Transaction 1: 3 hours ago - $20
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          HostCollectiveId: collective.host.id,
          amount: 20e2,
          currency: 'USD',
          createdAt: threeHoursAgo,
        },
        { createDoubleEntry: true },
      );

      // Transaction 2: 2 hours ago - $30 (cumulative: $50)
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          HostCollectiveId: collective.host.id,
          amount: 30e2,
          currency: 'USD',
          createdAt: twoHoursAgo,
        },
        { createDoubleEntry: true },
      );

      // Refresh materialized views
      await sequelize.query('REFRESH MATERIALIZED VIEW "TransactionBalances"');
      await sequelize.query('REFRESH MATERIALIZED VIEW "CollectiveBalanceCheckpoint"');

      // Transaction 3: 1 hour ago - $50 (cumulative: $100)
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          HostCollectiveId: collective.host.id,
          amount: 50e2,
          currency: 'USD',
          createdAt: oneHourAgo,
        },
        { createDoubleEntry: true },
      );

      // Query balance as of 90 minutes ago (should only include first two transactions: $50)
      const ninetyMinutesAgo = new Date(now.getTime() - 1000 * 60 * 90);
      const historicalBalances = await getHistoricalCollectiveBalances([collective.id], ninetyMinutesAgo);

      expect(historicalBalances[collective.id]).to.exist;
      expect(historicalBalances[collective.id].value).to.eq(50e2);
      expect(historicalBalances[collective.id].currency).to.eq('USD');
    });

    it('returns empty result when no transactions before endDate', async () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 1000 * 60 * 60);

      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          HostCollectiveId: collective.host.id,
          amount: 20e2,
          currency: 'USD',
          createdAt: now,
        },
        { createDoubleEntry: true },
      );

      await sequelize.query('REFRESH MATERIALIZED VIEW "TransactionBalances"');
      await sequelize.query('REFRESH MATERIALIZED VIEW "CollectiveBalanceCheckpoint"');

      // Query balance before any transactions exist
      const historicalBalances = await getHistoricalCollectiveBalances([collective.id], oneHourAgo);

      expect(historicalBalances[collective.id]).to.not.exist;
    });

    it('works through getBalances with endDate parameter', async () => {
      const now = new Date();
      const twoHoursAgo = new Date(now.getTime() - 1000 * 60 * 60 * 2);
      const threeHoursAgo = new Date(now.getTime() - 1000 * 60 * 60 * 3);

      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: collective.id,
          HostCollectiveId: collective.host.id,
          amount: 20e2,
          currency: 'USD',
          createdAt: threeHoursAgo,
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
          createdAt: twoHoursAgo,
        },
        { createDoubleEntry: true },
      );

      await sequelize.query('REFRESH MATERIALIZED VIEW "TransactionBalances"');
      await sequelize.query('REFRESH MATERIALIZED VIEW "CollectiveBalanceCheckpoint"');

      // getBalances should use the fast path when endDate is provided
      const ninetyMinutesAgo = new Date(now.getTime() - 1000 * 60 * 150);
      const balances = await getBalances([collective.id], { endDate: ninetyMinutesAgo });

      expect(balances[collective.id]).to.exist;
      expect(balances[collective.id].value).to.eq(20e2);
    });
  });

  describe('getSumCollectivesAmountSpent', () => {
    let collective;

    beforeEach(async () => {
      await resetTestDB();
      collective = await fakeCollective({ currency: 'USD' });
    });

    const createSpendTransactions = async () => {
      await fakeTransaction(
        {
          type: 'DEBIT',
          kind: TransactionKind.EXPENSE,
          CollectiveId: collective.id,
          amount: -50e2,
          createdAt: new Date('2025-06-15'),
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: 'DEBIT',
          kind: TransactionKind.EXPENSE,
          CollectiveId: collective.id,
          amount: -30e2,
          createdAt: new Date('2025-07-10'),
        },
        { createDoubleEntry: true },
      );
    };

    it('sums spent amounts as negative values', async () => {
      await createSpendTransactions();

      const results = await getSumCollectivesAmountSpent([collective.id]);
      expect(results[collective.id].value).to.equal(-80e2);
      expect(results[collective.id].currency).to.equal('USD');
    });

    it('excludes refunded transactions', async () => {
      await createSpendTransactions();
      const refunded = await fakeTransaction(
        {
          type: 'DEBIT',
          kind: TransactionKind.EXPENSE,
          CollectiveId: collective.id,
          amount: -20e2,
          createdAt: new Date('2025-07-15'),
        },
        { createDoubleEntry: true },
      );
      await refunded.update({ isRefund: true });

      const results = await getSumCollectivesAmountSpent([collective.id]);
      expect(results[collective.id].value).to.equal(-80e2);
    });

    it('skips the fast stats path when groupByAttributes is provided', async () => {
      await createSpendTransactions();
      await sequelize.query('REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"');

      // Precondition: the fast path *does* have data for this collective, so a
      // fast-path return would silently drop the grouping
      const fastResults = await getCurrentCollectiveTransactionStats([collective.id], {
        column: 'totalAmountSpentInHostCurrency',
      });
      expect(fastResults[collective.id]).to.exist;

      const results = await getSumCollectivesAmountSpent([collective.id], {
        groupByAttributes: [[sequelize.fn('DATE_TRUNC', 'month', sequelize.col('Transaction.createdAt')), 'date']],
      });

      expect(results[collective.id].value).to.equal(-80e2);
      expect(results[collective.id].groupBy).to.exist;
    });

    it('buckets amounts per period with groupByAttributes', async () => {
      await createSpendTransactions();

      const results = await getSumCollectivesAmountSpent([collective.id], {
        groupByAttributes: [[sequelize.fn('DATE_TRUNC', 'month', sequelize.col('Transaction.createdAt')), 'date']],
      });

      const buckets = Object.values(
        results[collective.id].groupBy.date as Record<string, { amount: number; date: Date }>,
      )
        .map(bucket => ({ date: bucket.date.toISOString(), amount: bucket.amount }))
        .sort((a, b) => a.date.localeCompare(b.date));
      expect(buckets).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', amount: -50e2 },
        { date: '2025-07-01T00:00:00.000Z', amount: -30e2 },
      ]);
    });

    it('returns net amounts when net is true', async () => {
      await fakeTransaction(
        {
          type: 'DEBIT',
          kind: TransactionKind.EXPENSE,
          CollectiveId: collective.id,
          amount: -50e2,
          paymentProcessorFeeInHostCurrency: -2e2,
          createdAt: new Date('2025-06-15'),
        },
        { createDoubleEntry: true },
      );

      const gross = await getSumCollectivesAmountSpent([collective.id]);
      const net = await getSumCollectivesAmountSpent([collective.id], { net: true });
      expect(gross[collective.id].value).to.equal(-50e2);
      expect(net[collective.id].value).to.equal(-52e2);
    });
  });

  describe('getTotalAmountSpentTimeSeries', () => {
    let collective;
    let project;

    beforeEach(async () => {
      await resetTestDB();
      collective = await fakeCollective({ currency: 'USD' });
      project = await fakeCollective({
        currency: 'USD',
        type: CollectiveType.PROJECT,
        ParentCollectiveId: collective.id,
      });

      await fakeTransaction(
        {
          type: 'DEBIT',
          kind: TransactionKind.EXPENSE,
          CollectiveId: collective.id,
          amount: -50e2,
          createdAt: new Date('2025-06-15'),
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: 'DEBIT',
          kind: TransactionKind.EXPENSE,
          CollectiveId: collective.id,
          amount: -30e2,
          createdAt: new Date('2025-07-10'),
        },
        { createDoubleEntry: true },
      );
    });

    const getNodesByDate = (series: { nodes: { date: Date | string; amount: { value: number } }[] }) =>
      series.nodes
        .map(node => ({ date: new Date(node.date).toISOString(), value: node.amount.value }))
        .sort((a, b) => a.date.localeCompare(b.date));

    it('returns one absolute node per period', async () => {
      const series = await getTotalAmountSpentTimeSeries(collective, {
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-08-01'),
        timeUnit: 'MONTH',
      });

      expect(series.dateFrom).to.deep.equal(new Date('2025-06-01'));
      expect(series.dateTo).to.deep.equal(new Date('2025-08-01'));
      expect(series.timeUnit).to.equal('MONTH');
      expect(getNodesByDate(series)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 50e2 },
        { date: '2025-07-01T00:00:00.000Z', value: 30e2 },
      ]);
    });

    it('returns signed values when absoluteAmounts is false', async () => {
      const series = await getTotalAmountSpentTimeSeries(collective, {
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-08-01'),
        timeUnit: 'MONTH',
        absoluteAmounts: false,
      });

      expect(getNodesByDate(series)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: -50e2 },
        { date: '2025-07-01T00:00:00.000Z', value: -30e2 },
      ]);
    });

    it('returns the same nodes through the loaders path', async () => {
      const options = {
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-08-01'),
        timeUnit: 'MONTH',
      };
      const direct = await getTotalAmountSpentTimeSeries(collective, options);
      const viaLoaders = await getTotalAmountSpentTimeSeries(collective, {
        ...options,
        loaders: makeRequest().loaders,
      });

      expect(getNodesByDate(viaLoaders)).to.deep.equal(getNodesByDate(direct));
    });

    it('includes children transactions when includeChildren is true', async () => {
      await fakeTransaction(
        {
          type: 'DEBIT',
          kind: TransactionKind.EXPENSE,
          CollectiveId: project.id,
          amount: -10e2,
          createdAt: new Date('2025-06-20'),
        },
        { createDoubleEntry: true },
      );

      const withoutChildren = await getTotalAmountSpentTimeSeries(collective, {
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-08-01'),
        timeUnit: 'MONTH',
      });
      const withChildren = await getTotalAmountSpentTimeSeries(collective, {
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-08-01'),
        timeUnit: 'MONTH',
        includeChildren: true,
      });

      expect(getNodesByDate(withoutChildren)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 50e2 },
        { date: '2025-07-01T00:00:00.000Z', value: 30e2 },
      ]);
      expect(getNodesByDate(withChildren)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 60e2 },
        { date: '2025-07-01T00:00:00.000Z', value: 30e2 },
      ]);
    });

    it('filters by transaction kind', async () => {
      await fakeTransaction(
        {
          type: 'DEBIT',
          kind: TransactionKind.PREPAID_PAYMENT_METHOD,
          CollectiveId: collective.id,
          amount: -25e2,
          createdAt: new Date('2025-06-20'),
        },
        { createDoubleEntry: true },
      );

      const series = await getTotalAmountSpentTimeSeries(collective, {
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-08-01'),
        timeUnit: 'MONTH',
        kind: [TransactionKind.EXPENSE],
      });

      expect(getNodesByDate(series)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 50e2 },
        { date: '2025-07-01T00:00:00.000Z', value: 30e2 },
      ]);
    });

    it('restricts nodes to the startDate/endDate window', async () => {
      const series = await getTotalAmountSpentTimeSeries(collective, {
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-07-01'),
        timeUnit: 'MONTH',
      });

      expect(getNodesByDate(series)).to.deep.equal([{ date: '2025-06-01T00:00:00.000Z', value: 50e2 }]);
    });

    it('converts amounts to the requested currency', async () => {
      const sandbox = createSandbox();
      try {
        sandbox.stub(libcurrency, 'getFxRate').withArgs('USD', 'USD').resolves(1).withArgs('USD', 'EUR').resolves(0.9);

        const series = await getTotalAmountSpentTimeSeries(collective, {
          startDate: new Date('2025-06-01'),
          endDate: new Date('2025-08-01'),
          timeUnit: 'MONTH',
          currency: 'EUR',
        });

        expect(series.nodes.every(node => node.amount.currency === 'EUR')).to.be.true;
        expect(getNodesByDate(series)).to.deep.equal([
          { date: '2025-06-01T00:00:00.000Z', value: 45e2 },
          { date: '2025-07-01T00:00:00.000Z', value: 27e2 },
        ]);
      } finally {
        sandbox.restore();
      }
    });

    it('returns empty nodes when there are no transactions', async () => {
      const emptyCollective = await fakeCollective({ currency: 'USD' });
      const series = await getTotalAmountSpentTimeSeries(emptyCollective, {
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-08-01'),
        timeUnit: 'MONTH',
      });

      expect(series.nodes).to.deep.equal([]);
    });
  });

  describe('getTotalAmountReceivedAmount', () => {
    let collective;

    beforeEach(async () => {
      collective = await fakeCollective({ currency: 'USD' });
    });

    it('sums received transactions in the collective currency', async () => {
      await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: 20e2 }, { createDoubleEntry: true });
      await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: 30e2 }, { createDoubleEntry: true });

      const result = await getTotalAmountReceivedAmount(collective);
      expect(result).to.deep.equal({ value: 50e2, currency: 'USD' });
    });

    it('returns the same amount through the loaders path', async () => {
      await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: 20e2 }, { createDoubleEntry: true });
      await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: 30e2 }, { createDoubleEntry: true });

      const viaLoaders = await getTotalAmountReceivedAmount(collective, { loaders: makeRequest().loaders });
      expect(viaLoaders).to.deep.equal({ value: 50e2, currency: 'USD' });
    });

    it('applies the date range and net amount used by the dashboards', async () => {
      await fakeTransaction(
        {
          type: 'CREDIT',
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          amount: 100e2,
          paymentProcessorFeeInHostCurrency: -10e2,
          createdAt: new Date('2025-06-15'),
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: 'CREDIT',
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          amount: 40e2,
          createdAt: new Date('2025-07-10'),
        },
        { createDoubleEntry: true },
      );

      const options = { startDate: new Date('2025-06-01'), endDate: new Date('2025-07-01') };
      const gross = await getTotalAmountReceivedAmount(collective, options);
      const net = await getTotalAmountReceivedAmount(collective, { ...options, net: true });

      expect(gross).to.deep.equal({ value: 100e2, currency: 'USD' });
      expect(net).to.deep.equal({ value: 90e2, currency: 'USD' });

      // No date filters: exercises the materialized-stats column selection.
      const netWithoutDates = await getTotalAmountReceivedAmount(collective, { net: true });
      expect(netWithoutDates).to.deep.equal({ value: 130e2, currency: 'USD' });
    });

    it('includes children accounts', async () => {
      const child = await fakeCollective({ type: CollectiveType.PROJECT, ParentCollectiveId: collective.id });
      await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: 20e2 }, { createDoubleEntry: true });
      await fakeTransaction({ type: 'CREDIT', CollectiveId: child.id, amount: 30e2 }, { createDoubleEntry: true });

      const withoutChildren = await getTotalAmountReceivedAmount(collective);
      const withChildren = await getTotalAmountReceivedAmount(collective, { includeChildren: true });

      expect(withoutChildren.value).to.equal(20e2);
      expect(withChildren.value).to.equal(50e2);
    });

    it('filters by transaction kind', async () => {
      await fakeTransaction(
        { type: 'CREDIT', kind: TransactionKind.CONTRIBUTION, CollectiveId: collective.id, amount: 20e2 },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        { type: 'CREDIT', kind: TransactionKind.ADDED_FUNDS, CollectiveId: collective.id, amount: 30e2 },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        { type: 'CREDIT', kind: TransactionKind.PLATFORM_TIP, CollectiveId: collective.id, amount: 40e2 },
        { createDoubleEntry: true },
      );

      const result = await getTotalAmountReceivedAmount(collective, {
        kind: [TransactionKind.CONTRIBUTION, TransactionKind.ADDED_FUNDS],
      });
      expect(result.value).to.equal(50e2);
    });
  });

  describe('getTotalAmountSpentAmount', () => {
    let collective;

    beforeEach(async () => {
      collective = await fakeCollective({ currency: 'USD' });
    });

    it('sums spent transactions as negative amounts', async () => {
      await fakeTransaction(
        { type: 'DEBIT', kind: TransactionKind.EXPENSE, CollectiveId: collective.id, amount: -50e2 },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        { type: 'DEBIT', kind: TransactionKind.EXPENSE, CollectiveId: collective.id, amount: -30e2 },
        { createDoubleEntry: true },
      );

      const result = await getTotalAmountSpentAmount(collective);
      expect(result).to.deep.equal({ value: -80e2, currency: 'USD' });
    });

    it('returns the same amount through the loaders path', async () => {
      await fakeTransaction(
        { type: 'DEBIT', kind: TransactionKind.EXPENSE, CollectiveId: collective.id, amount: -50e2 },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        { type: 'DEBIT', kind: TransactionKind.EXPENSE, CollectiveId: collective.id, amount: -30e2 },
        { createDoubleEntry: true },
      );

      const viaLoaders = await getTotalAmountSpentAmount(collective, { loaders: makeRequest().loaders });
      expect(viaLoaders).to.deep.equal({ value: -80e2, currency: 'USD' });
    });

    it('applies the date range and net amount used by the dashboards', async () => {
      await fakeTransaction(
        {
          type: 'DEBIT',
          kind: TransactionKind.EXPENSE,
          CollectiveId: collective.id,
          amount: -50e2,
          paymentProcessorFeeInHostCurrency: -2e2,
          createdAt: new Date('2025-06-15'),
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: 'DEBIT',
          kind: TransactionKind.EXPENSE,
          CollectiveId: collective.id,
          amount: -30e2,
          createdAt: new Date('2025-07-10'),
        },
        { createDoubleEntry: true },
      );

      const options = { startDate: new Date('2025-06-01'), endDate: new Date('2025-07-01') };
      const gross = await getTotalAmountSpentAmount(collective, options);
      const net = await getTotalAmountSpentAmount(collective, { ...options, net: true });

      expect(gross.value).to.equal(-50e2);
      expect(net.value).to.equal(-52e2);

      // No date filters: exercises the materialized-stats column selection.
      const netWithoutDates = await getTotalAmountSpentAmount(collective, { net: true });
      expect(netWithoutDates.value).to.equal(-82e2);
    });

    it('includes children accounts', async () => {
      const child = await fakeCollective({ type: CollectiveType.PROJECT, ParentCollectiveId: collective.id });
      await fakeTransaction(
        { type: 'DEBIT', kind: TransactionKind.EXPENSE, CollectiveId: collective.id, amount: -50e2 },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        { type: 'DEBIT', kind: TransactionKind.EXPENSE, CollectiveId: child.id, amount: -30e2 },
        { createDoubleEntry: true },
      );

      const withoutChildren = await getTotalAmountSpentAmount(collective);
      const withChildren = await getTotalAmountSpentAmount(collective, { includeChildren: true });

      expect(withoutChildren.value).to.equal(-50e2);
      expect(withChildren.value).to.equal(-80e2);
    });
  });

  describe('getTotalAmountPaidExpenses', () => {
    let collective;

    beforeEach(async () => {
      collective = await fakeCollective({ currency: 'USD' });
    });

    it('sums paid expenses', async () => {
      await fakeExpense({
        FromCollectiveId: collective.id,
        status: ExpenseStatuses.PAID,
        amount: 20e2,
        currency: 'USD',
      });
      await fakeExpense({
        FromCollectiveId: collective.id,
        status: ExpenseStatuses.PAID,
        amount: 30e2,
        currency: 'USD',
      });
      await fakeExpense({
        FromCollectiveId: collective.id,
        status: ExpenseStatuses.PENDING,
        amount: 40e2,
        currency: 'USD',
      });

      const result = await getTotalAmountPaidExpenses(collective);
      expect(result).to.deep.equal({ value: 50e2, currency: 'USD' });
    });

    it('filters by expense type', async () => {
      await fakeExpense({
        FromCollectiveId: collective.id,
        status: ExpenseStatuses.PAID,
        type: 'INVOICE',
        amount: 20e2,
        currency: 'USD',
      });
      await fakeExpense({
        FromCollectiveId: collective.id,
        status: ExpenseStatuses.PAID,
        type: 'RECEIPT',
        amount: 30e2,
        currency: 'USD',
      });

      const result = await getTotalAmountPaidExpenses(collective, { expenseType: 'INVOICE' });
      expect(result).to.deep.equal({ value: 20e2, currency: 'USD' });
    });

    it('filters by multiple expense types and date range', async () => {
      await fakeExpense({
        FromCollectiveId: collective.id,
        status: ExpenseStatuses.PAID,
        type: 'INVOICE',
        amount: 20e2,
        currency: 'USD',
        createdAt: new Date('2025-06-15'),
      });
      await fakeExpense({
        FromCollectiveId: collective.id,
        status: ExpenseStatuses.PAID,
        type: 'RECEIPT',
        amount: 30e2,
        currency: 'USD',
        createdAt: new Date('2025-06-20'),
      });
      await fakeExpense({
        FromCollectiveId: collective.id,
        status: ExpenseStatuses.PAID,
        type: 'INVOICE',
        amount: 40e2,
        currency: 'USD',
        createdAt: new Date('2025-07-10'),
      });

      const result = await getTotalAmountPaidExpenses(collective, {
        expenseType: ['INVOICE', 'RECEIPT'],
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-07-01'),
      });

      expect(result).to.deep.equal({ value: 50e2, currency: 'USD' });
    });
  });

  describe('getContributionsAndContributorsCount', () => {
    let collective;
    let contributor1;
    let contributor2;

    beforeEach(async () => {
      collective = await fakeCollective();
      contributor1 = await fakeUser();
      contributor2 = await fakeUser();
    });

    const createContribution = (FromCollectiveId: number, amount: number, createdAt?: Date) =>
      fakeTransaction(
        {
          type: 'CREDIT',
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId,
          amount,
          createdAt,
        },
        { createDoubleEntry: true },
      );

    it('counts contributions and distinct contributors', async () => {
      await createContribution(contributor1.CollectiveId, 10e2);
      await createContribution(contributor1.CollectiveId, 20e2);
      await createContribution(contributor2.CollectiveId, 30e2);

      const result = await getContributionsAndContributorsCount(collective);
      expect(result).to.deep.equal({ contributionsCount: 3, contributorsCount: 2 });
    });

    it('returns zeros without contributions', async () => {
      const result = await getContributionsAndContributorsCount(collective);
      expect(result).to.deep.equal({ contributionsCount: 0, contributorsCount: 0 });
    });

    it('returns the same counts through the loaders path', async () => {
      await createContribution(contributor1.CollectiveId, 10e2);
      await createContribution(contributor2.CollectiveId, 30e2);

      const result = await getContributionsAndContributorsCount(collective, { loaders: makeRequest().loaders });
      expect(result).to.deep.equal({ contributionsCount: 2, contributorsCount: 2 });
    });

    it('filters by date range', async () => {
      await createContribution(contributor1.CollectiveId, 10e2, new Date('2025-06-15'));
      await createContribution(contributor2.CollectiveId, 20e2, new Date('2025-07-10'));

      const result = await getContributionsAndContributorsCount(collective, {
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-07-01'),
      });

      expect(result).to.deep.equal({ contributionsCount: 1, contributorsCount: 1 });
    });

    it('includes children accounts', async () => {
      const child = await fakeCollective({ type: CollectiveType.PROJECT, ParentCollectiveId: collective.id });
      await createContribution(contributor1.CollectiveId, 10e2);
      await fakeTransaction(
        {
          type: 'CREDIT',
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: child.id,
          FromCollectiveId: contributor2.CollectiveId,
          amount: 20e2,
        },
        { createDoubleEntry: true },
      );

      const withoutChildren = await getContributionsAndContributorsCount(collective);
      const withChildren = await getContributionsAndContributorsCount(collective, { includeChildren: true });

      expect(withoutChildren).to.deep.equal({ contributionsCount: 1, contributorsCount: 1 });
      expect(withChildren).to.deep.equal({ contributionsCount: 2, contributorsCount: 2 });
    });
  });

  describe('getTotalAmountReceivedTimeSeries', () => {
    let collective;

    beforeEach(async () => {
      collective = await fakeCollective({ currency: 'USD' });

      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: collective.id, amount: 50e2, createdAt: new Date('2025-06-15') },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: collective.id, amount: 30e2, createdAt: new Date('2025-07-10') },
        { createDoubleEntry: true },
      );
    });

    const getNodesByDate = (series: { nodes: { date: Date | string; amount: { value: number } }[] }) =>
      series.nodes
        .map(node => ({ date: new Date(node.date).toISOString(), value: node.amount.value }))
        .sort((a, b) => a.date.localeCompare(b.date));

    it('returns one node per period', async () => {
      const series = await getTotalAmountReceivedTimeSeries(collective, {
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-08-01'),
        timeUnit: 'MONTH',
      });

      expect(getNodesByDate(series)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 50e2 },
        { date: '2025-07-01T00:00:00.000Z', value: 30e2 },
      ]);
    });

    it('returns the same nodes through the loaders path', async () => {
      const options = {
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-08-01'),
        timeUnit: 'MONTH',
      };
      const direct = await getTotalAmountReceivedTimeSeries(collective, options);
      const viaLoaders = await getTotalAmountReceivedTimeSeries(collective, {
        ...options,
        loaders: makeRequest().loaders,
      });

      expect(getNodesByDate(viaLoaders)).to.deep.equal(getNodesByDate(direct));
    });

    it('returns net amounts', async () => {
      const netCollective = await fakeCollective({ currency: 'USD' });
      await fakeTransaction(
        {
          type: 'CREDIT',
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: netCollective.id,
          amount: 100e2,
          paymentProcessorFeeInHostCurrency: -10e2,
          createdAt: new Date('2025-06-15'),
        },
        { createDoubleEntry: true },
      );

      const options = {
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-07-01'),
        timeUnit: 'MONTH',
      };
      const gross = await getTotalAmountReceivedTimeSeries(netCollective, options);
      const net = await getTotalAmountReceivedTimeSeries(netCollective, {
        ...options,
        net: true,
        loaders: makeRequest().loaders,
      });

      expect(getNodesByDate(gross)).to.deep.equal([{ date: '2025-06-01T00:00:00.000Z', value: 100e2 }]);
      expect(getNodesByDate(net)).to.deep.equal([{ date: '2025-06-01T00:00:00.000Z', value: 90e2 }]);
    });

    it('includes children accounts', async () => {
      const child = await fakeCollective({ type: CollectiveType.PROJECT, ParentCollectiveId: collective.id });
      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: child.id, amount: 40e2, createdAt: new Date('2025-06-20') },
        { createDoubleEntry: true },
      );

      const options = {
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-08-01'),
        timeUnit: 'MONTH',
      };
      const withoutChildren = await getTotalAmountReceivedTimeSeries(collective, options);
      const withChildren = await getTotalAmountReceivedTimeSeries(collective, { ...options, includeChildren: true });

      expect(getNodesByDate(withoutChildren)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 50e2 },
        { date: '2025-07-01T00:00:00.000Z', value: 30e2 },
      ]);
      expect(getNodesByDate(withChildren)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 90e2 },
        { date: '2025-07-01T00:00:00.000Z', value: 30e2 },
      ]);
    });

    it('returns empty nodes when there are no transactions', async () => {
      const emptyCollective = await fakeCollective({ currency: 'USD' });
      const series = await getTotalAmountReceivedTimeSeries(emptyCollective, {
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-08-01'),
        timeUnit: 'MONTH',
      });

      expect(series.nodes).to.deep.equal([]);
    });
  });

  describe('getBalanceTimeSeries', () => {
    let collective;

    beforeEach(async () => {
      collective = await fakeCollective({ currency: 'USD' });
    });

    const getNodesByDate = (series: { nodes: { date: Date | string; amount: { value: number } }[] }) =>
      series.nodes
        .map(node => ({ date: new Date(node.date).toISOString(), value: node.amount.value }))
        .sort((a, b) => a.date.localeCompare(b.date));

    it('accumulates the balance across periods', async () => {
      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: collective.id, amount: 50e2, createdAt: new Date('2025-06-15') },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: collective.id, amount: 30e2, createdAt: new Date('2025-07-10') },
        { createDoubleEntry: true },
      );

      const series = await getBalanceTimeSeries(collective, {
        endDate: new Date('2025-08-01'),
        timeUnit: 'MONTH',
      });

      expect(getNodesByDate(series)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 50e2 },
        { date: '2025-07-01T00:00:00.000Z', value: 80e2 },
      ]);
    });

    it('starts from the balance before startDate', async () => {
      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: collective.id, amount: 10e2, createdAt: new Date('2025-05-10') },
        { createDoubleEntry: true },
      );
      await sequelize.query('REFRESH MATERIALIZED VIEW "TransactionBalances"');
      await sequelize.query('REFRESH MATERIALIZED VIEW "CollectiveBalanceCheckpoint"');

      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: collective.id, amount: 50e2, createdAt: new Date('2025-06-15') },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: collective.id, amount: 30e2, createdAt: new Date('2025-07-10') },
        { createDoubleEntry: true },
      );

      const series = await getBalanceTimeSeries(collective, {
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-08-01'),
        timeUnit: 'MONTH',
      });

      expect(getNodesByDate(series)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 60e2 },
        { date: '2025-07-01T00:00:00.000Z', value: 90e2 },
      ]);
    });

    it('includes children accounts', async () => {
      const child = await fakeCollective({ type: CollectiveType.PROJECT, ParentCollectiveId: collective.id });
      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: collective.id, amount: 50e2, createdAt: new Date('2025-06-15') },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        { type: 'CREDIT', CollectiveId: child.id, amount: 30e2, createdAt: new Date('2025-06-20') },
        { createDoubleEntry: true },
      );

      const options = { endDate: new Date('2025-08-01'), timeUnit: 'MONTH' };
      const withoutChildren = await getBalanceTimeSeries(collective, options);
      const withChildren = await getBalanceTimeSeries(collective, { ...options, includeChildren: true });

      expect(getNodesByDate(withoutChildren)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 50e2 },
        { date: '2025-07-01T00:00:00.000Z', value: 50e2 },
      ]);
      expect(getNodesByDate(withChildren)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 80e2 },
        { date: '2025-07-01T00:00:00.000Z', value: 80e2 },
      ]);
    });

    it('returns empty nodes when there are no transactions', async () => {
      const emptyCollective = await fakeCollective({ currency: 'USD' });
      const series = await getBalanceTimeSeries(emptyCollective, {
        endDate: new Date('2025-08-01'),
        timeUnit: 'MONTH',
      });

      expect(series.nodes).to.deep.equal([]);
    });
  });

  describe('getBlockedContributionsCount', () => {
    let collective;

    beforeEach(async () => {
      collective = await fakeCollective();
    });

    it('counts disputed contributions', async () => {
      await fakeTransaction(
        {
          type: 'CREDIT',
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          amount: 20e2,
          isDisputed: true,
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        { type: 'CREDIT', kind: TransactionKind.CONTRIBUTION, CollectiveId: collective.id, amount: 30e2 },
        { createDoubleEntry: true },
      );

      expect(await getBlockedContributionsCount(collective.id)).to.equal(1);
    });

    it('ignores refunded contributions', async () => {
      const original = await fakeTransaction(
        { type: 'CREDIT', kind: TransactionKind.CONTRIBUTION, CollectiveId: collective.id, amount: 20e2 },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: 'CREDIT',
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          amount: 20e2,
          isDisputed: true,
          RefundTransactionId: original.id,
        },
        { createDoubleEntry: true },
      );

      expect(await getBlockedContributionsCount(collective.id)).to.equal(0);
    });
  });
});
