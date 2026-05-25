import { expect } from 'chai';

// @ts-expect-error - migration uses module.exports interop
import migration from '../../migrations/20260507160000-backfill-stripe-cleared-at-charge-created-fiscal-hosts'; // eslint-disable-line import/default
import { Collective, sequelize, Transaction, User } from '../../server/models';
import { fakeActiveHost, fakeCollective, fakeTransaction, fakeUser, randStr } from '../test-helpers/fake-data';
import { resetTestDB } from '../utils';

/** Unix timestamps (seconds) for Stripe `charge.created` and `balance_transaction.available_on`. */
function stripeData(availableOn: number, chargeCreated: number) {
  return {
    // eslint-disable-next-line camelcase
    balanceTransaction: { available_on: availableOn },
    charge: { created: chargeCreated },
  };
}

describe('migrations/20260507160000-backfill-stripe-cleared-at-charge-created-fiscal-hosts', () => {
  let raftHost: Collective, user: User;
  beforeEach(async () => {
    await resetTestDB();
    user = await fakeUser();
    raftHost = await fakeActiveHost({
      slug: 'raft',
      name: 'Raft test host',
      CreatedByUserId: user.id,
    });
  });

  describe('up', () => {
    it('updates matching Raft host transactions: sets clearedAt from charge.created and stores previous clearedAt in data', async () => {
      const collective = await fakeCollective({
        HostCollectiveId: raftHost.id,
        CreatedByUserId: user.id,
      });

      const availableOnUnix = 1731369600;
      const chargeCreatedUnix = 1728537600;
      const beforeCreatedAt = new Date('2025-11-10T12:00:00.000Z');

      const tx = await fakeTransaction({
        CollectiveId: collective.id,
        HostCollectiveId: raftHost.id,
        CreatedByUserId: user.id,
        createdAt: beforeCreatedAt,
        clearedAt: new Date(availableOnUnix * 1000),
        data: stripeData(availableOnUnix, chargeCreatedUnix) as Transaction['data'],
      });

      await migration.up(sequelize.getQueryInterface());

      await tx.reload();
      expect(tx.createdAt.getTime()).to.equal(beforeCreatedAt.getTime());
      expect(tx.clearedAt.getTime()).to.equal(chargeCreatedUnix * 1000);
      expect(tx.data?.['dateBeforeMigration20260507160000']).to.exist;
      expect(new Date(tx.data?.['dateBeforeMigration20260507160000'] as string).getTime()).to.equal(
        availableOnUnix * 1000,
      );
    });

    it('does not update transactions for other fiscal hosts', async () => {
      const otherHost = await fakeActiveHost({
        slug: `other-host-${randStr()}`,
        CreatedByUserId: user.id,
      });
      const collective = await fakeCollective({
        HostCollectiveId: otherHost.id,
        CreatedByUserId: user.id,
      });

      const availableOnUnix = 1731369600;
      const chargeCreatedUnix = 1728537600;
      const beforeCreatedAt = new Date('2025-11-10T12:00:00.000Z');

      const tx = await fakeTransaction({
        CollectiveId: collective.id,
        HostCollectiveId: otherHost.id,
        CreatedByUserId: user.id,
        createdAt: beforeCreatedAt,
        clearedAt: new Date(availableOnUnix * 1000),
        data: stripeData(availableOnUnix, chargeCreatedUnix) as Transaction['data'],
      });

      await migration.up(sequelize.getQueryInterface());

      await tx.reload();
      expect(tx.createdAt.getTime()).to.equal(beforeCreatedAt.getTime());
      expect(tx.clearedAt.getTime()).to.equal(availableOnUnix * 1000);
      expect(tx.data?.['dateBeforeMigration20260507160000']).to.be.undefined;
    });

    it('does not update transactions with createdAt before the migration cutoff', async () => {
      const collective = await fakeCollective({
        HostCollectiveId: raftHost.id,
        CreatedByUserId: user.id,
      });

      const availableOnUnix = 1731369600;
      const chargeCreatedUnix = 1728537600;
      const beforeCreatedAt = new Date('2025-11-05T12:00:00.000Z');

      const tx = await fakeTransaction({
        CollectiveId: collective.id,
        HostCollectiveId: raftHost.id,
        CreatedByUserId: user.id,
        createdAt: beforeCreatedAt,
        clearedAt: new Date(availableOnUnix * 1000),
        data: stripeData(availableOnUnix, chargeCreatedUnix) as Transaction['data'],
      });

      await migration.up(sequelize.getQueryInterface());

      await tx.reload();
      expect(tx.createdAt.getTime()).to.equal(beforeCreatedAt.getTime());
      expect(tx.clearedAt.getTime()).to.equal(availableOnUnix * 1000);
      expect(tx.data?.['dateBeforeMigration20260507160000']).to.be.undefined;
    });

    it('does not update when charge.created and clearedAt already match', async () => {
      const collective = await fakeCollective({
        HostCollectiveId: raftHost.id,
        CreatedByUserId: user.id,
      });

      const sharedUnix = 1731369600;
      const beforeCreatedAt = new Date('2025-11-10T12:00:00.000Z');

      const tx = await fakeTransaction({
        CollectiveId: collective.id,
        HostCollectiveId: raftHost.id,
        CreatedByUserId: user.id,
        createdAt: beforeCreatedAt,
        clearedAt: new Date(sharedUnix * 1000),
        data: stripeData(sharedUnix, sharedUnix) as Transaction['data'],
      });

      await migration.up(sequelize.getQueryInterface());

      await tx.reload();
      expect(tx.createdAt.getTime()).to.equal(beforeCreatedAt.getTime());
      expect(tx.clearedAt.getTime()).to.equal(sharedUnix * 1000);
      expect(tx.data?.['dateBeforeMigration20260507160000']).to.be.undefined;
    });
  });

  describe('down', () => {
    it('restores clearedAt from data.dateBeforeMigration20260507160000 for rows in scope', async () => {
      const collective = await fakeCollective({
        HostCollectiveId: raftHost.id,
        CreatedByUserId: user.id,
      });

      const availableOnUnix = 1731369600;
      const chargeCreatedUnix = 1728537600;
      const beforeCreatedAt = new Date('2025-11-10T12:00:00.000Z');

      const tx = await fakeTransaction({
        CollectiveId: collective.id,
        HostCollectiveId: raftHost.id,
        CreatedByUserId: user.id,
        createdAt: beforeCreatedAt,
        clearedAt: new Date(availableOnUnix * 1000),
        data: stripeData(availableOnUnix, chargeCreatedUnix) as Transaction['data'],
      });

      await migration.up(sequelize.getQueryInterface());
      await migration.down(sequelize.getQueryInterface());

      await tx.reload();
      expect(tx.createdAt.getTime()).to.equal(beforeCreatedAt.getTime());
      expect(tx.clearedAt.getTime()).to.equal(availableOnUnix * 1000);
    });
  });
});
