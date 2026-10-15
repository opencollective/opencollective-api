import { expect } from 'chai';
import nock from 'nock';

import { TransactionKind } from '../../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../../server/constants/transactions';
import { fakeCollective, fakeTransaction } from '../../../test-helpers/fake-data';
import { makeRequest, nockFixerRates, resetCaches, resetTestDB } from '../../../utils';

describe('server/graphql/loaders/index', () => {
  beforeEach(async () => {
    await resetTestDB();
    await resetCaches();
  });

  describe('Transaction.totalAmountDonatedFromTo', () => {
    let collective, fromCollective, otherCollective;

    beforeEach(async () => {
      collective = await fakeCollective({ currency: 'USD' });
      fromCollective = await fakeCollective();
      otherCollective = await fakeCollective();
    });

    it('returns 0 when there are no matching transactions', async () => {
      const req = makeRequest();

      const total = await req.loaders.Transaction.totalAmountDonatedFromTo.load({
        FromCollectiveId: fromCollective.id,
        CollectiveId: collective.id,
        currency: 'USD',
      });

      expect(total).to.equal(0);
    });

    it('sums credit transactions in the same currency', async () => {
      await fakeTransaction(
        {
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
          FromCollectiveId: fromCollective.id,
          amount: 1000,
          currency: 'USD',
          type: TransactionTypes.CREDIT,
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
          FromCollectiveId: fromCollective.id,
          amount: 500,
          currency: 'USD',
          type: TransactionTypes.CREDIT,
        },
        { createDoubleEntry: true },
      );

      const req = makeRequest();
      const total = await req.loaders.Transaction.totalAmountDonatedFromTo.load({
        FromCollectiveId: fromCollective.id,
        CollectiveId: collective.id,
        currency: 'USD',
      });

      expect(total).to.equal(1500);
    });

    it('converts amounts to the requested currency', async () => {
      nockFixerRates({ USD: { EUR: 0.84 } });

      await fakeTransaction(
        {
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
          FromCollectiveId: fromCollective.id,
          amount: 1000,
          currency: 'USD',
          type: TransactionTypes.CREDIT,
        },
        { createDoubleEntry: true },
      );

      const req = makeRequest();
      const total = await req.loaders.Transaction.totalAmountDonatedFromTo.load({
        FromCollectiveId: fromCollective.id,
        CollectiveId: collective.id,
        currency: 'EUR',
      });

      expect(total).to.equal(Math.round(1000 * 0.84));
    });

    it('converts and sums amounts from multiple currencies', async () => {
      nockFixerRates({ USD: { EUR: 0.84 } });

      await fakeTransaction(
        {
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
          FromCollectiveId: fromCollective.id,
          amount: 1000,
          currency: 'USD',
          type: TransactionTypes.CREDIT,
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
          FromCollectiveId: fromCollective.id,
          amount: 500,
          currency: 'EUR',
          type: TransactionTypes.CREDIT,
        },
        { createDoubleEntry: true },
      );

      const req = makeRequest();
      const total = await req.loaders.Transaction.totalAmountDonatedFromTo.load({
        FromCollectiveId: fromCollective.id,
        CollectiveId: collective.id,
        currency: 'EUR',
      });

      expect(total).to.equal(Math.round(500 + 1000 * 0.84));
    });

    it('includes gift card contributions for the gift card emitter', async () => {
      const giftCardEmitter = await fakeCollective();

      await fakeTransaction(
        {
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
          FromCollectiveId: fromCollective.id,
          UsingGiftCardFromCollectiveId: giftCardEmitter.id,
          amount: 2000,
          currency: 'USD',
          type: TransactionTypes.CREDIT,
        },
        { createDoubleEntry: true },
      );

      const req = makeRequest();

      const emitterTotal = await req.loaders.Transaction.totalAmountDonatedFromTo.load({
        FromCollectiveId: giftCardEmitter.id,
        CollectiveId: collective.id,
        currency: 'USD',
      });
      const contributorTotal = await req.loaders.Transaction.totalAmountDonatedFromTo.load({
        FromCollectiveId: fromCollective.id,
        CollectiveId: collective.id,
        currency: 'USD',
      });

      expect(emitterTotal).to.equal(2000);
      expect(contributorTotal).to.equal(2000);
    });

    it('excludes host fee transactions', async () => {
      await fakeTransaction(
        {
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
          FromCollectiveId: fromCollective.id,
          amount: 1000,
          currency: 'USD',
          type: TransactionTypes.CREDIT,
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          kind: TransactionKind.HOST_FEE,
          CollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
          FromCollectiveId: fromCollective.id,
          amount: 100,
          currency: 'USD',
          type: TransactionTypes.CREDIT,
        },
        { createDoubleEntry: true },
      );

      const req = makeRequest();
      const total = await req.loaders.Transaction.totalAmountDonatedFromTo.load({
        FromCollectiveId: fromCollective.id,
        CollectiveId: collective.id,
        currency: 'USD',
      });

      expect(total).to.equal(1000);
    });

    it('excludes refunded transactions', async () => {
      const contribution = await fakeTransaction(
        {
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
          FromCollectiveId: fromCollective.id,
          amount: 1000,
          currency: 'USD',
          type: TransactionTypes.CREDIT,
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
          FromCollectiveId: fromCollective.id,
          amount: 500,
          currency: 'USD',
          type: TransactionTypes.CREDIT,
          RefundTransactionId: contribution.id,
        },
        { createDoubleEntry: true },
      );

      const req = makeRequest();
      const total = await req.loaders.Transaction.totalAmountDonatedFromTo.load({
        FromCollectiveId: fromCollective.id,
        CollectiveId: collective.id,
        currency: 'USD',
      });

      expect(total).to.equal(1000);
    });

    it('does not include transactions from other contributors', async () => {
      await fakeTransaction(
        {
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
          FromCollectiveId: fromCollective.id,
          amount: 1000,
          currency: 'USD',
          type: TransactionTypes.CREDIT,
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
          FromCollectiveId: otherCollective.id,
          amount: 5000,
          currency: 'USD',
          type: TransactionTypes.CREDIT,
        },
        { createDoubleEntry: true },
      );

      const req = makeRequest();
      const total = await req.loaders.Transaction.totalAmountDonatedFromTo.load({
        FromCollectiveId: fromCollective.id,
        CollectiveId: collective.id,
        currency: 'USD',
      });

      expect(total).to.equal(1000);
    });

    afterEach(() => {
      nock.cleanAll();
    });
  });

  describe('Collective.amountSpentTimeSeries', () => {
    let collective;
    let otherCollective;

    beforeEach(async () => {
      collective = await fakeCollective({ currency: 'USD' });
      otherCollective = await fakeCollective({ currency: 'USD' });

      await fakeTransaction(
        {
          type: TransactionTypes.DEBIT,
          kind: TransactionKind.EXPENSE,
          CollectiveId: collective.id,
          amount: -50e2,
          createdAt: new Date('2025-06-15'),
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: TransactionTypes.DEBIT,
          kind: TransactionKind.EXPENSE,
          CollectiveId: collective.id,
          amount: -30e2,
          createdAt: new Date('2025-07-10'),
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: TransactionTypes.DEBIT,
          kind: TransactionKind.EXPENSE,
          CollectiveId: otherCollective.id,
          amount: -20e2,
          createdAt: new Date('2025-06-20'),
        },
        { createDoubleEntry: true },
      );
    });

    it('returns the period buckets for a collective', async () => {
      const req = makeRequest();
      const result = await req.loaders.Collective.amountSpentTimeSeries
        .buildLoader({ timeUnit: 'MONTH', startDate: new Date('2025-06-01'), endDate: new Date('2025-08-01') })
        .load(collective.id);

      expect(result.CollectiveId).to.equal(collective.id);
      expect(result.currency).to.equal('USD');
      expect(result.value).to.equal(-80e2);

      const buckets = Object.values(result.groupBy.date as Record<string, { amount: number; date: Date }>)
        .map(bucket => ({ date: bucket.date.toISOString(), amount: bucket.amount }))
        .sort((a, b) => a.date.localeCompare(b.date));
      expect(buckets).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', amount: -50e2 },
        { date: '2025-07-01T00:00:00.000Z', amount: -30e2 },
      ]);
    });

    it('returns the same loader instance for the same arguments and a new one otherwise', async () => {
      const req = makeRequest();
      const first = req.loaders.Collective.amountSpentTimeSeries.buildLoader({ timeUnit: 'MONTH' });
      const sameArgs = req.loaders.Collective.amountSpentTimeSeries.buildLoader({ timeUnit: 'MONTH' });
      const otherArgs = req.loaders.Collective.amountSpentTimeSeries.buildLoader({ timeUnit: 'YEAR' });

      expect(sameArgs).to.equal(first);
      expect(otherArgs).to.not.equal(first);
    });

    it('batches loads and sorts results by collective id', async () => {
      const req = makeRequest();
      const loader = req.loaders.Collective.amountSpentTimeSeries.buildLoader({
        timeUnit: 'MONTH',
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-08-01'),
      });

      const [first, second] = await Promise.all([loader.load(collective.id), loader.load(otherCollective.id)]);

      expect(first.CollectiveId).to.equal(collective.id);
      expect(first.value).to.equal(-80e2);
      expect(second.CollectiveId).to.equal(otherCollective.id);
      expect(second.value).to.equal(-20e2);
    });
  });
});
