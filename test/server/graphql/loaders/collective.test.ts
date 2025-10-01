import { expect } from 'chai';
import moment from 'moment';

import { CollectiveType } from '../../../../server/constants/collectives';
import MemberRoles from '../../../../server/constants/roles';
import { TransactionKind } from '../../../../server/constants/transaction-kind';
import CollectiveLoaders from '../../../../server/graphql/loaders/collective';
import {
  fakeActiveHost,
  fakeCollective,
  fakeMember,
  fakeMemberInvitation,
  fakeTransaction,
  fakeUser,
  multiple,
} from '../../../test-helpers/fake-data';
import { makeRequest, resetTestDB } from '../../../utils';

describe('server/graphql/loaders/collective', () => {
  before(async () => {
    await resetTestDB();
  });

  describe('canSeePrivateProfileInfo', () => {
    describe('User info', () => {
      let userWithPrivateInfo, randomUser, collectiveAdmin, hostAdmin, invitedUserWithPrivateInfo;

      before(async () => {
        userWithPrivateInfo = await fakeUser();
        invitedUserWithPrivateInfo = await fakeUser();
        randomUser = await fakeUser();
        collectiveAdmin = await fakeUser();
        hostAdmin = await fakeUser();

        const collective = await fakeCollective();
        await collective.addUserWithRole(userWithPrivateInfo, 'BACKER');
        await collective.addUserWithRole(collectiveAdmin, 'ADMIN');
        await collective.host.addUserWithRole(hostAdmin, 'ADMIN');
        await fakeMemberInvitation({
          CollectiveId: collective.id,
          MemberCollectiveId: invitedUserWithPrivateInfo.CollectiveId,
          role: MemberRoles.ADMIN,
        });
      });

      it('Cannot see infos as unauthenticated', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: null });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Cannot see infos as a random user', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: randomUser });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Can see infos if self', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: userWithPrivateInfo });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });

      it('Can see infos if collective admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: collectiveAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });

      it('Can see infos if user is invited to collective', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: collectiveAdmin });
        const result = await loader.load(invitedUserWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });

      it('Can see infos if host admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: hostAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });
    });

    describe('Incognito user info', () => {
      let userWithPrivateInfo, incognitoProfile, randomUser, collectiveAdmin, hostAdmin;

      before(async () => {
        userWithPrivateInfo = await fakeUser();
        randomUser = await fakeUser();
        collectiveAdmin = await fakeUser();
        hostAdmin = await fakeUser();
        incognitoProfile = await fakeCollective({
          type: CollectiveType.USER,
          isIncognito: true,
          name: 'Incognito',
          HostCollectiveId: null,
          CreatedByUserId: userWithPrivateInfo.id,
        });
        const collective = await fakeCollective();
        await collective.addUserWithRole(collectiveAdmin, 'ADMIN');
        await collective.host.addUserWithRole(hostAdmin, 'ADMIN');

        // Here we're making the incognito profile a backer of the collective (rather than
        // using `userWithPrivateInfo` directly)
        await fakeMember({
          role: MemberRoles.BACKER,
          MemberCollectiveId: incognitoProfile.id,
          CollectiveId: collective.id,
        });
        await incognitoProfile.addUserWithRole(userWithPrivateInfo, 'ADMIN');
      });

      it('Cannot see infos as unauthenticated', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: null });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Cannot see infos as a random user', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: randomUser });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Can see infos if self', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: userWithPrivateInfo });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });

      it('Cannot see infos if collective admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: collectiveAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Cannot see infos if host admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: hostAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });
    });
  });

  describe('canSeePrivateLocation', () => {
    let userWithPrivateInfo, randomUser, collectiveAdmin, hostAdmin;

    before(async () => {
      userWithPrivateInfo = await fakeUser();
      randomUser = await fakeUser();
      collectiveAdmin = await fakeUser();
      hostAdmin = await fakeUser();

      const collective = await fakeCollective();
      await collective.addUserWithRole(userWithPrivateInfo, 'BACKER');
      await collective.addUserWithRole(collectiveAdmin, 'ADMIN');
      await collective.host.addUserWithRole(hostAdmin, 'ADMIN');
    });

    it('Cannot see infos as unauthenticated', async () => {
      const loader = CollectiveLoaders.canSeePrivateLocation({ remoteUser: null });
      const result = await loader.load(userWithPrivateInfo.CollectiveId);
      expect(result).to.be.false;
    });

    it('Cannot see infos as a random user', async () => {
      const loader = CollectiveLoaders.canSeePrivateLocation({ remoteUser: randomUser });
      const result = await loader.load(userWithPrivateInfo.CollectiveId);
      expect(result).to.be.false;
    });

    it('Can see infos if self', async () => {
      const loader = CollectiveLoaders.canSeePrivateLocation({ remoteUser: userWithPrivateInfo });
      const result = await loader.load(userWithPrivateInfo.CollectiveId);
      expect(result).to.be.true;
    });

    it('Cannot see infos if collective admin', async () => {
      const loader = CollectiveLoaders.canSeePrivateLocation({ remoteUser: collectiveAdmin });
      const result = await loader.load(userWithPrivateInfo.CollectiveId);
      expect(result).to.be.false;
    });

    it('Can see infos if host admin', async () => {
      const loader = CollectiveLoaders.canSeePrivateLocation({ remoteUser: hostAdmin });
      const result = await loader.load(userWithPrivateInfo.CollectiveId);
      expect(result).to.be.true;
    });
  });

  describe('transactionSummary', () => {
    let collectives;
    const today = moment().utc().startOf('day').toDate();
    const lastWeek = moment().utc().subtract(8, 'days').toDate();

    before(async () => {
      const host = await fakeActiveHost();
      collectives = await multiple(fakeCollective, 3, {
        HostCollectiveId: host.id,
        approvedAt: moment().utc().subtract(10, 'days').toDate(),
      });
      await Promise.all(
        collectives.map(async c => {
          await fakeTransaction({
            CollectiveId: c.id,
            kind: TransactionKind.EXPENSE,
            amount: -1000,
            HostCollectiveId: host.id,
            createdAt: today,
          });
          await fakeTransaction({
            CollectiveId: c.id,
            kind: TransactionKind.CONTRIBUTION,
            amount: 1000,
            HostCollectiveId: host.id,
            createdAt: today,
          });
          await fakeTransaction({
            CollectiveId: c.id,
            kind: TransactionKind.HOST_FEE,
            amount: -100,
            HostCollectiveId: host.id,
            createdAt: today,
          });
        }),
      );
      await Promise.all(
        collectives.map(async c => {
          await fakeTransaction({
            CollectiveId: c.id,
            kind: TransactionKind.EXPENSE,
            amount: -2000,
            HostCollectiveId: host.id,
            createdAt: lastWeek,
          });
          await fakeTransaction({
            CollectiveId: c.id,
            kind: TransactionKind.CONTRIBUTION,
            amount: 1500,
            HostCollectiveId: host.id,
            createdAt: lastWeek,
          });
          await fakeTransaction({
            CollectiveId: c.id,
            kind: TransactionKind.HOST_FEE,
            amount: -150,
            HostCollectiveId: host.id,
            createdAt: lastWeek,
          });
        }),
      );
    });

    it('should return the financial summary for a collective', async () => {
      const request = makeRequest();
      const result = await request.loaders.Collective.stats.hostedAccountSummary.buildLoader().load(collectives[0].id);

      expect(result).to.containSubset({
        CollectiveId: collectives[0].id,
        hostCurrency: 'USD',
        expenseCount: 2,
        expenseTotal: 3000,
        expenseMaxValue: 2000,
        expenseDistinctPayee: 2,
        contributionCount: 2,
        contributionTotal: 2500,
        hostFeeTotal: 250,
        spentTotal: 3000,
      });
    });

    it('should return the financial summary for a collective since date', async () => {
      const request = makeRequest();
      const result = await request.loaders.Collective.stats.hostedAccountSummary
        .buildLoader({ dateFrom: moment().utc().subtract(4, 'days').toDate() })
        .load(collectives[0].id);

      expect(result).to.containSubset({
        CollectiveId: collectives[0].id,
        hostCurrency: 'USD',
        expenseCount: 1,
        expenseTotal: 1000,
        expenseMaxValue: 1000,
        expenseDistinctPayee: 1,
        contributionCount: 1,
        contributionTotal: 1000,
        hostFeeTotal: 100,
        spentTotal: 1000,
      });
    });
  });
});
