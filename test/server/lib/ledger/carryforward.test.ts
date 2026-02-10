import { expect } from 'chai';
import moment from 'moment';

import { TransactionKind } from '../../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../../server/constants/transactions';
import { getBalances } from '../../../../server/lib/budget';
import {
  computeCarryforwardBalance,
  createBalanceCarryforward,
  getBalancesByHostAndCurrency,
} from '../../../../server/lib/ledger/carryforward';
import { fakeCollective, fakeHost, fakeTransaction } from '../../../test-helpers/fake-data';
import { resetTestDB, snapshotLedger } from '../../../utils';

const CARRYFORWARD_SNAPSHOT_COLUMNS = [
  'kind',
  'type',
  'amount',
  'amountInHostCurrency',
  'CollectiveId',
  'FromCollectiveId',
  'HostCollectiveId',
  'isInternal',
  'description',
];

describe('server/lib/ledger/carryforward', () => {
  before(resetTestDB);

  describe('getBalancesByHostAndCurrency', () => {
    let host1, host2, collective;

    beforeEach(async () => {
      host1 = await fakeHost({ name: 'Host 1', currency: 'USD' });
      host2 = await fakeHost({ name: 'Host 2', currency: 'EUR' });
      collective = await fakeCollective({ name: 'Test Collective', HostCollectiveId: host1.id, currency: 'USD' });
    });

    it('returns balances grouped by host and currency', async () => {
      // Transaction with host1 in USD
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: host1.id,
          amount: 100e2,
          amountInHostCurrency: 100e2,
          hostCurrency: 'USD',
        },
        { createDoubleEntry: true },
      );

      const balances = await getBalancesByHostAndCurrency(collective.id);
      expect(balances).to.have.length(1);
      expect(balances[0].HostCollectiveId).to.equal(host1.id);
      expect(balances[0].hostCurrency).to.equal('USD');
      expect(balances[0].balance).to.equal(100e2);
    });

    it('respects endDate filter', async () => {
      const oldDate = moment().subtract(60, 'days').toDate();
      const recentDate = moment().subtract(10, 'days').toDate();

      // Old transaction
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: host1.id,
          amount: 100e2,
          amountInHostCurrency: 100e2,
          hostCurrency: 'USD',
          createdAt: oldDate,
        },
        { createDoubleEntry: true },
      );

      // Recent transaction
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: host1.id,
          amount: 50e2,
          amountInHostCurrency: 50e2,
          hostCurrency: 'USD',
          createdAt: recentDate,
        },
        { createDoubleEntry: true },
      );

      // Query with endDate before recent transaction
      const cutoffDate = moment().subtract(30, 'days').toDate();
      const balances = await getBalancesByHostAndCurrency(collective.id, { endDate: cutoffDate });

      expect(balances).to.have.length(1);
      expect(balances[0].balance).to.equal(100e2); // Only old transaction
    });

    it('returns multiple entries for different hosts', async () => {
      // Transaction with host1
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: host1.id,
          amount: 100e2,
          amountInHostCurrency: 100e2,
          hostCurrency: 'USD',
        },
        { createDoubleEntry: true },
      );

      // Transaction with host2 (simulating host change)
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: host2.id,
          amount: 50e2,
          amountInHostCurrency: 50e2,
          hostCurrency: 'EUR',
        },
        { createDoubleEntry: true },
      );

      const balances = await getBalancesByHostAndCurrency(collective.id);
      expect(balances).to.have.length(2);

      const host1Balance = balances.find(b => b.HostCollectiveId === host1.id);
      const host2Balance = balances.find(b => b.HostCollectiveId === host2.id);

      expect(host1Balance.balance).to.equal(100e2);
      expect(host2Balance.balance).to.equal(50e2);
    });
  });

  describe('computeCarryforwardBalance', () => {
    let host, collective, contributor;

    beforeEach(async () => {
      host = await fakeHost({ name: 'Test Host', currency: 'USD' });
      collective = await fakeCollective({ name: 'Test Collective', HostCollectiveId: host.id, currency: 'USD' });
      contributor = await fakeCollective({ name: 'Contributor' });
    });

    it('returns SKIPPED_NO_HOST_TRANSACTIONS when no transactions with host', async () => {
      const carryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();
      const result = await computeCarryforwardBalance(collective.id, carryforwardDate);

      expect(result.status).to.equal('SKIPPED_NO_HOST_TRANSACTIONS');
    });

    it('returns SKIPPED_ZERO_BALANCE when balance is zero', async () => {
      // Create a contribution and then an expense that zeroes out the balance
      const txDate = moment().subtract(60, 'days').toDate();

      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: contributor.id,
          HostCollectiveId: host.id,
          amount: 100e2,
          amountInHostCurrency: 100e2,
          hostCurrency: 'USD',
          createdAt: txDate,
        },
        { createDoubleEntry: true },
      );

      await fakeTransaction(
        {
          type: TransactionTypes.DEBIT,
          kind: TransactionKind.EXPENSE,
          CollectiveId: collective.id,
          FromCollectiveId: contributor.id,
          HostCollectiveId: host.id,
          amount: -100e2,
          amountInHostCurrency: -100e2,
          hostCurrency: 'USD',
          createdAt: txDate,
        },
        { createDoubleEntry: true },
      );

      const carryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();
      const result = await computeCarryforwardBalance(collective.id, carryforwardDate);

      expect(result.status).to.equal('SKIPPED_ZERO_BALANCE');
    });

    it('returns SKIPPED_ALREADY_EXISTS when carryforward exists', async () => {
      // Create a transaction
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: contributor.id,
          HostCollectiveId: host.id,
          amount: 100e2,
          amountInHostCurrency: 100e2,
          hostCurrency: 'USD',
          createdAt: moment().subtract(60, 'days').toDate(),
        },
        { createDoubleEntry: true },
      );

      const carryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();

      // Create carryforward
      await createBalanceCarryforward(collective, carryforwardDate);

      // Try to compute again
      const result = await computeCarryforwardBalance(collective.id, carryforwardDate);

      expect(result.status).to.equal('SKIPPED_ALREADY_EXISTS');
    });

    it('returns CREATED with correct balance for v2 budget', async () => {
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: contributor.id,
          HostCollectiveId: host.id,
          amount: 150e2,
          amountInHostCurrency: 150e2,
          hostCurrency: 'USD',
          createdAt: moment().subtract(60, 'days').toDate(),
        },
        { createDoubleEntry: true },
      );

      const carryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();
      const result = await computeCarryforwardBalance(collective.id, carryforwardDate);

      expect(result.status).to.equal('CREATED');
      expect(result.balance).to.equal(150e2);
      expect(result.currency).to.equal('USD');
      expect(result.isBalanceInCollectiveCurrency).to.equal(false);
    });

    it('returns ERROR_MULTI_CURRENCY for multiple currencies in v2', async () => {
      const txDate = moment().subtract(60, 'days').toDate();

      // USD transaction
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: contributor.id,
          HostCollectiveId: host.id,
          amount: 100e2,
          amountInHostCurrency: 100e2,
          hostCurrency: 'USD',
          createdAt: txDate,
        },
        { createDoubleEntry: true },
      );

      // EUR transaction (different host currency)
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: contributor.id,
          HostCollectiveId: host.id,
          amount: 50e2,
          amountInHostCurrency: 50e2,
          hostCurrency: 'EUR',
          createdAt: txDate,
        },
        { createDoubleEntry: true },
      );

      const carryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();
      const result = await computeCarryforwardBalance(collective.id, carryforwardDate);

      expect(result.status).to.equal('ERROR_MULTI_CURRENCY');
      expect(result.error).to.include('Multiple non-zero balances');
    });

    describe('v1 budget version', () => {
      beforeEach(async () => {
        await collective.update({
          settings: { ...collective.settings, budget: { version: 'v1' } },
        });
      });

      it('returns CREATED with balance in collective currency', async () => {
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            FromCollectiveId: contributor.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            amountInHostCurrency: 100e2,
            netAmountInCollectiveCurrency: 100e2,
            currency: 'USD',
            hostCurrency: 'USD',
            createdAt: moment().subtract(60, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        const carryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();
        const result = await computeCarryforwardBalance(collective.id, carryforwardDate);

        expect(result.status).to.equal('CREATED');
        expect(result.balance).to.equal(100e2);
        expect(result.isBalanceInCollectiveCurrency).to.equal(true);
      });

      it('handles multi-currency by converting to primary currency', async () => {
        const txDate = moment().subtract(60, 'days').toDate();

        // Large USD transaction
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            FromCollectiveId: contributor.id,
            HostCollectiveId: host.id,
            amount: 1000e2,
            amountInHostCurrency: 1000e2,
            netAmountInCollectiveCurrency: 1000e2,
            currency: 'USD',
            hostCurrency: 'USD',
            createdAt: txDate,
          },
          { createDoubleEntry: true },
        );

        // Smaller EUR transaction
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            FromCollectiveId: contributor.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            amountInHostCurrency: 100e2,
            netAmountInCollectiveCurrency: 100e2,
            currency: 'EUR',
            hostCurrency: 'EUR',
            createdAt: txDate,
          },
          { createDoubleEntry: true },
        );

        const carryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();
        const result = await computeCarryforwardBalance(collective.id, carryforwardDate);

        expect(result.status).to.equal('CREATED');
        expect(result.currency).to.equal('USD'); // Primary currency (larger balance)
        expect(result.conversionDetails).to.include('EUR');
        expect(result.isBalanceInCollectiveCurrency).to.equal(true);
      });
    });

    describe('v3 budget version', () => {
      beforeEach(async () => {
        await collective.update({
          settings: { ...collective.settings, budget: { version: 'v3' } },
        });
      });

      it('returns CREATED for single host/currency', async () => {
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            FromCollectiveId: contributor.id,
            HostCollectiveId: host.id,
            amount: 200e2,
            amountInHostCurrency: 200e2,
            hostCurrency: 'USD',
            createdAt: moment().subtract(60, 'days').toDate(),
          },
          { createDoubleEntry: true },
        );

        const carryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();
        const result = await computeCarryforwardBalance(collective.id, carryforwardDate);

        expect(result.status).to.equal('CREATED');
        expect(result.balance).to.equal(200e2);
        expect(result.currency).to.equal('USD');
      });

      it('returns ERROR_MULTI_CURRENCY for multiple hosts', async () => {
        const host2 = await fakeHost({ name: 'Host 2', currency: 'EUR' });
        const txDate = moment().subtract(60, 'days').toDate();

        // Transaction with host1
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            FromCollectiveId: contributor.id,
            HostCollectiveId: host.id,
            amount: 100e2,
            amountInHostCurrency: 100e2,
            hostCurrency: 'USD',
            createdAt: txDate,
          },
          { createDoubleEntry: true },
        );

        // Transaction with host2
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            FromCollectiveId: contributor.id,
            HostCollectiveId: host2.id,
            amount: 50e2,
            amountInHostCurrency: 50e2,
            hostCurrency: 'EUR',
            createdAt: txDate,
          },
          { createDoubleEntry: true },
        );

        const carryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();
        const result = await computeCarryforwardBalance(collective.id, carryforwardDate);

        expect(result.status).to.equal('ERROR_MULTI_CURRENCY');
        expect(result.error).to.include('Multiple non-zero balances');
      });
    });
  });

  describe('createBalanceCarryforward', () => {
    let host, collective, contributor;

    beforeEach(async () => {
      host = await fakeHost({ name: 'Test Host', currency: 'USD' });
      collective = await fakeCollective({ name: 'Test Collective', HostCollectiveId: host.id, currency: 'USD' });
      contributor = await fakeCollective({ name: 'Contributor' });
    });

    it('throws error for future carryforward date', async () => {
      const futureDate = moment().add(1, 'day').toDate();

      try {
        await createBalanceCarryforward(collective, futureDate);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('Carryforward date must be in the past');
      }
    });

    it('creates closing and opening transactions', async () => {
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: contributor.id,
          HostCollectiveId: host.id,
          amount: 150e2,
          amountInHostCurrency: 150e2,
          hostCurrency: 'USD',
          createdAt: moment().subtract(60, 'days').toDate(),
        },
        { createDoubleEntry: true },
      );

      const carryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();
      const result = await createBalanceCarryforward(collective, carryforwardDate);

      expect(result.status).to.equal('CREATED');
      expect(result.balance).to.equal(150e2);

      // Verify closing transaction
      expect(result.closingTransaction.type).to.equal(TransactionTypes.DEBIT);
      expect(result.closingTransaction.kind).to.equal(TransactionKind.BALANCE_CARRYFORWARD);
      expect(result.closingTransaction.amountInHostCurrency).to.equal(-150e2);
      expect(result.closingTransaction.isInternal).to.equal(true);

      // Verify opening transaction
      expect(result.openingTransaction.type).to.equal(TransactionTypes.CREDIT);
      expect(result.openingTransaction.kind).to.equal(TransactionKind.BALANCE_CARRYFORWARD);
      expect(result.openingTransaction.amountInHostCurrency).to.equal(150e2);
      expect(result.openingTransaction.isInternal).to.equal(true);

      // Verify they share the same TransactionGroup
      expect(result.closingTransaction.TransactionGroup).to.equal(result.openingTransaction.TransactionGroup);
    });

    it('is idempotent - returns SKIPPED_ALREADY_EXISTS on second call', async () => {
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: contributor.id,
          HostCollectiveId: host.id,
          amount: 100e2,
          amountInHostCurrency: 100e2,
          hostCurrency: 'USD',
          createdAt: moment().subtract(60, 'days').toDate(),
        },
        { createDoubleEntry: true },
      );

      const carryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();

      // First call creates
      const result1 = await createBalanceCarryforward(collective, carryforwardDate);
      expect(result1.status).to.equal('CREATED');

      // Second call skips
      const result2 = await createBalanceCarryforward(collective, carryforwardDate);
      expect(result2.status).to.equal('SKIPPED_ALREADY_EXISTS');
    });

    it('preserves balance after carryforward', async () => {
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: contributor.id,
          HostCollectiveId: host.id,
          amount: 250e2,
          amountInHostCurrency: 250e2,
          hostCurrency: 'USD',
          createdAt: moment().subtract(60, 'days').toDate(),
        },
        { createDoubleEntry: true },
      );

      // Get balance before
      const balanceBefore = await getBalances([collective.id], { useMaterializedView: false });
      expect(balanceBefore[collective.id].value).to.equal(250e2);

      // Create carryforward
      const carryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();
      await createBalanceCarryforward(collective, carryforwardDate);

      // Get balance after
      const balanceAfter = await getBalances([collective.id], { useMaterializedView: false });
      expect(balanceAfter[collective.id].value).to.equal(250e2);
    });

    it('uses historical host from transactions', async () => {
      const oldHost = await fakeHost({ name: 'Old Host', currency: 'USD' });

      // Transaction with old host (before host change)
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: contributor.id,
          HostCollectiveId: oldHost.id,
          amount: 100e2,
          amountInHostCurrency: 100e2,
          hostCurrency: 'USD',
          createdAt: moment().subtract(60, 'days').toDate(),
        },
        { createDoubleEntry: true },
      );

      const carryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();
      const result = await createBalanceCarryforward(collective, carryforwardDate);

      expect(result.status).to.equal('CREATED');
      // Carryforward should use the historical host from transactions
      expect(result.closingTransaction.HostCollectiveId).to.equal(oldHost.id);
    });
  });

  describe('Ledger snapshot', () => {
    let host, collective, contributor;

    beforeEach(async () => {
      host = await fakeHost({ name: 'Test Host', currency: 'USD' });
      collective = await fakeCollective({ name: 'Test Collective', HostCollectiveId: host.id, currency: 'USD' });
      contributor = await fakeCollective({ name: 'Contributor' });
    });

    it('ledger state before and after carryforward', async () => {
      // Create a contribution transaction 60 days ago
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: contributor.id,
          HostCollectiveId: host.id,
          amount: 150e2,
          createdAt: moment().subtract(60, 'days').toDate(),
          description: 'Original contribution',
        },
        { createDoubleEntry: true },
      );

      // Snapshot ledger BEFORE carryforward
      await snapshotLedger(CARRYFORWARD_SNAPSHOT_COLUMNS, {
        where: { CollectiveId: collective.id },
        order: [['id', 'ASC']],
      });

      // Create carryforward
      const carryforwardDate = moment().subtract(30, 'days').endOf('day').toDate();
      const result = await createBalanceCarryforward(collective, carryforwardDate);
      expect(result.status).to.equal('CREATED');

      // Snapshot ledger AFTER carryforward
      await snapshotLedger(CARRYFORWARD_SNAPSHOT_COLUMNS, {
        where: { CollectiveId: collective.id },
        order: [['id', 'ASC']],
      });

      // Verify balance is unchanged
      const balance = await getBalances([collective.id], { useMaterializedView: false });
      expect(balance[collective.id].value).to.equal(150e2);
    });
  });
});
