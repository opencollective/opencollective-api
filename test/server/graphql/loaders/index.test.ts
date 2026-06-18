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
});
