import { expect } from 'chai';
import moment from 'moment';
import { createSandbox } from 'sinon';

import ExpenseStatuses from '../../../server/constants/expense-status';
import OrderStatuses from '../../../server/constants/order-status';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../server/constants/transactions';
import {
  getBalances,
  getCurrentCollectiveBalances,
  getCurrentCollectiveTransactionStats,
  getHistoricalCollectiveBalances,
  getSumCollectivesAmountSpent,
  getTotalAmountSpentTimeSeries,
  getTotalMoneyManagedAmount,
  getYearlyBudgets,
  sumCollectivesTransactions,
} from '../../../server/lib/budget';
import * as libcurrency from '../../../server/lib/currency';
import { sequelize } from '../../../server/models';
import { fakeCollective, fakeExpense, fakeOrder, fakeTransaction } from '../../test-helpers/fake-data';
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
        startDate: moment().subtract(1, 'day'),
        endDate: moment(),
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
      project = await fakeCollective({ currency: 'USD', type: 'PROJECT', ParentCollectiveId: collective.id });

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
          kind: TransactionKind.PREPAID_EXPENSE,
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
});
