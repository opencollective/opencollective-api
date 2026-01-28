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
  getTotalMoneyManagedAmount,
  getYearlyBudgets,
  sumCollectivesTransactions,
} from '../../../server/lib/budget';
import * as libcurrency from '../../../server/lib/currency';
import { createBalanceCarryforward, getBalancesByHostAndCurrency } from '../../../server/lib/ledger/carryforward';
import { sequelize } from '../../../server/models';
import { fakeCollective, fakeExpense, fakeHost, fakeOrder, fakeTransaction } from '../../test-helpers/fake-data';
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

  describe('createBalanceCarryforward', () => {
    let host, collective;

    beforeEach(async () => {
      await resetTestDB();
      host = await fakeHost();
      collective = await fakeCollective({ HostCollectiveId: host.id, approvedAt: new Date() });
    });

    describe('getBalancesByHostAndCurrency()', () => {
      it('returns balances grouped by host and currency', async () => {
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            createdAt: moment().subtract(30, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        const balances = await getBalancesByHostAndCurrency(collective.id);

        expect(balances).to.have.length(1);
        expect(balances[0].HostCollectiveId).to.equal(host.id);
        expect(balances[0].hostCurrency).to.equal(host.currency);
        expect(balances[0].balance).to.equal(100e2);
      });

      it('respects endDate parameter', async () => {
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            createdAt: moment().subtract(30, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 50e2,
            createdAt: moment().subtract(10, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        // Query with endDate before the second transaction
        const endDate = moment().subtract(15, 'days').toDate();
        const balances = await getBalancesByHostAndCurrency(collective.id, { endDate });

        expect(balances).to.have.length(1);
        expect(balances[0].balance).to.equal(100e2);
      });

      it('returns empty array for collective with no transactions', async () => {
        const balances = await getBalancesByHostAndCurrency(collective.id);
        expect(balances).to.have.length(0);
      });
    });

    describe('createBalanceCarryforward()', () => {
      it('creates DEBIT and CREDIT transaction pair with correct amounts', async () => {
        // Create some balance
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            createdAt: moment().subtract(30, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        const carryforwardDate = moment().subtract(1, 'day').endOf('day').toDate();

        const result = await createBalanceCarryforward(collective, carryforwardDate);

        expect(result).to.not.be.null;
        expect(result.balance).to.equal(100e2);
        expect(result.closingTransaction).to.exist;
        expect(result.openingTransaction).to.exist;
        expect(result.balancesByHost).to.exist;
        expect(result.balancesByHost).to.have.length(1);
        expect(result.balancesByHost[0].HostCollectiveId).to.equal(host.id);
        expect(result.balancesByHost[0].balance).to.equal(100e2);

        // Check closing transaction (DEBIT)
        expect(result.closingTransaction.type).to.equal(TransactionTypes.DEBIT);
        expect(result.closingTransaction.kind).to.equal(TransactionKind.BALANCE_CARRYFORWARD);
        expect(result.closingTransaction.amountInHostCurrency).to.equal(-100e2);
        expect(result.closingTransaction.description).to.equal('Balance carryforward - Closing');
        expect(result.closingTransaction.isInternal).to.be.true;

        // Check opening transaction (CREDIT)
        expect(result.openingTransaction.type).to.equal(TransactionTypes.CREDIT);
        expect(result.openingTransaction.kind).to.equal(TransactionKind.BALANCE_CARRYFORWARD);
        expect(result.openingTransaction.amountInHostCurrency).to.equal(100e2);
        expect(result.openingTransaction.description).to.equal('Balance carryforward - Opening');
        expect(result.openingTransaction.isInternal).to.be.true;
      });

      it('returns null when balance is zero', async () => {
        // Create offsetting transactions that result in zero balance
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            createdAt: moment().subtract(30, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );
        await fakeTransaction(
          {
            type: TransactionTypes.DEBIT,
            kind: TransactionKind.EXPENSE,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: -100e2,
            createdAt: moment().subtract(20, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        const carryforwardDate = moment().subtract(1, 'day').endOf('day').toDate();
        const result = await createBalanceCarryforward(collective, carryforwardDate);

        expect(result).to.be.null;
      });

      it('transactions share the same TransactionGroup', async () => {
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            createdAt: moment().subtract(30, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        const carryforwardDate = moment().subtract(1, 'day').endOf('day').toDate();
        const result = await createBalanceCarryforward(collective, carryforwardDate);

        expect(result.closingTransaction.TransactionGroup).to.equal(result.openingTransaction.TransactionGroup);
      });

      it('transactions have correct HostCollectiveId', async () => {
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            createdAt: moment().subtract(30, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        const carryforwardDate = moment().subtract(1, 'day').endOf('day').toDate();
        const result = await createBalanceCarryforward(collective, carryforwardDate);

        expect(result.closingTransaction.HostCollectiveId).to.equal(host.id);
        expect(result.openingTransaction.HostCollectiveId).to.equal(host.id);
      });

      it('closing transaction dated before opening transaction', async () => {
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            createdAt: moment().subtract(30, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        const carryforwardDate = moment().subtract(1, 'day').endOf('day').toDate();
        const result = await createBalanceCarryforward(collective, carryforwardDate);

        expect(result.closingTransaction.createdAt.getTime()).to.be.lessThan(
          result.openingTransaction.createdAt.getTime(),
        );
      });

      it('errors if collective has no transactions with a host', async () => {
        const collectiveWithoutHost = await fakeCollective({ HostCollectiveId: null });
        const carryforwardDate = moment().subtract(1, 'day').endOf('day').toDate();

        await expect(createBalanceCarryforward(collectiveWithoutHost, carryforwardDate)).to.be.rejectedWith(
          'No transactions found with a host before the carryforward date',
        );
      });

      it('allows multiple carryforwards at any dates', async () => {
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            createdAt: moment().subtract(60, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        // First carryforward at a recent date
        const recentCarryforwardDate = moment().subtract(10, 'days').endOf('day').toDate();
        const recentResult = await createBalanceCarryforward(collective, recentCarryforwardDate);
        expect(recentResult).to.not.be.null;

        // Second carryforward at an earlier date - should work
        const earlierCarryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();
        const earlierResult = await createBalanceCarryforward(collective, earlierCarryforwardDate);
        expect(earlierResult).to.not.be.null;

        // Balance should still be correct
        const balance = await getBalances([collective.id], { useMaterializedView: false });
        expect(balance[collective.id].value).to.equal(100e2);
      });

      it('errors if carryforward date is in the future', async () => {
        const futureDate = moment().add(1, 'day').toDate();

        await expect(createBalanceCarryforward(collective, futureDate)).to.be.rejectedWith(
          'Carryforward date must be in the past',
        );
      });

      it('errors if carryforward already exists at the same date', async () => {
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            createdAt: moment().subtract(30, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        const carryforwardDate = moment().subtract(10, 'days').endOf('day').toDate();

        // First carryforward should succeed
        await createBalanceCarryforward(collective, carryforwardDate);

        // Second carryforward at same date should fail
        await expect(createBalanceCarryforward(collective, carryforwardDate)).to.be.rejectedWith(
          'A carryforward already exists at this date',
        );
      });

      it('handles negative balances correctly', async () => {
        // Create a negative balance by having more debits than credits
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 50e2,
            createdAt: moment().subtract(30, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );
        await fakeTransaction(
          {
            type: TransactionTypes.DEBIT,
            kind: TransactionKind.EXPENSE,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: -100e2,
            createdAt: moment().subtract(20, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        const carryforwardDate = moment().subtract(1, 'day').endOf('day').toDate();
        const result = await createBalanceCarryforward(collective, carryforwardDate);

        expect(result.balance).to.equal(-50e2);
        expect(result.closingTransaction.amountInHostCurrency).to.equal(50e2); // Positive (removes negative balance)
        expect(result.openingTransaction.amountInHostCurrency).to.equal(-50e2); // Negative (establishes negative balance)
      });
    });

    describe('Balance calculation with carryforward', () => {
      it('getBalances() returns same balance before and after carryforward', async () => {
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            createdAt: moment().subtract(30, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        // Get balance before carryforward
        const balanceBefore = await getBalances([collective.id], { useMaterializedView: false });

        // Create carryforward
        const carryforwardDate = moment().subtract(1, 'day').endOf('day').toDate();
        await createBalanceCarryforward(collective, carryforwardDate);

        // Get balance after carryforward
        await collective.reload();
        const balanceAfter = await getBalances([collective.id], { useMaterializedView: false });

        expect(balanceAfter[collective.id].value).to.equal(balanceBefore[collective.id].value);
      });

      it('balance is correct after new transactions are added post-carryforward', async () => {
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            createdAt: moment().subtract(30, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        // Create carryforward
        const carryforwardDate = moment().subtract(1, 'day').endOf('day').toDate();
        await createBalanceCarryforward(collective, carryforwardDate);

        // Add new transaction after carryforward
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 50e2,
            createdAt: new Date(),
          },
          { createDoubleEntry: true },
        );

        await collective.reload();
        const balance = await getBalances([collective.id], { useMaterializedView: false });

        expect(balance[collective.id].value).to.equal(150e2);
      });

      it('historical balance query with endDate before carryforward uses full transaction history', async () => {
        const oldDate = moment().subtract(60, 'days').toDate();
        const carryforwardDate = moment().subtract(10, 'days').endOf('day').toDate();

        // Create old transaction
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            createdAt: oldDate,
          },
          { createDoubleEntry: true },
        );

        // Create carryforward at a later date
        await createBalanceCarryforward(collective, carryforwardDate);
        await collective.reload();

        // Query historical balance (before carryforward date)
        const historicalEndDate = moment().subtract(30, 'days').toDate();
        const balance = await getBalances([collective.id], {
          endDate: historicalEndDate,
          useMaterializedView: false,
        });

        expect(balance[collective.id].value).to.equal(100e2);
      });
    });

    describe('Metric exclusion', () => {
      it('carryforward transactions are excluded from sumCollectivesTransactions when excludeInternals is true', async () => {
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            createdAt: moment().subtract(30, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        // Create carryforward
        const carryforwardDate = moment().subtract(1, 'day').endOf('day').toDate();
        await createBalanceCarryforward(collective, carryforwardDate);

        // Query with excludeInternals: true (like contribution totals)
        const txs = await sumCollectivesTransactions([collective.id], {
          column: 'netAmountInHostCurrency',
          transactionType: TransactionTypes.CREDIT,
          excludeInternals: true,
          excludeRefunds: true,
        });

        // Should only include the original contribution, not the carryforward credit
        expect(txs[collective.id]['value']).to.equal(100e2);
      });

      it('carryforward transactions are included in ledger queries (excludeInternals: false)', async () => {
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            createdAt: moment().subtract(30, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        // Create carryforward
        const carryforwardDate = moment().subtract(1, 'day').endOf('day').toDate();
        await createBalanceCarryforward(collective, carryforwardDate);

        // Query with excludeInternals: false (like balance calculation)
        const txs = await sumCollectivesTransactions([collective.id], {
          column: 'netAmountInHostCurrency',
          excludeInternals: false,
          excludeRefunds: false,
        });

        // Balance should remain the same (carryforward nets to zero)
        expect(txs[collective.id]['value']).to.equal(100e2);
      });
    });
  });
});
