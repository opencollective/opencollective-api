import { expect } from 'chai';
import { times } from 'lodash';

import { generateCanSeeAccountPrivateInfoLoader } from '../../../../server/graphql/loaders/user.ts';
import { fakeCollective, fakeMember, fakeOrganization, fakeUser } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('server/graphql/loaders/user', () => {
  // before(async () => {
  //   await resetTestDB();
  // });

  describe('canSeeAccountPrivateInfoLoader', () => {
    describe('User info', () => {
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
        const loader = generateCanSeeAccountPrivateInfoLoader({ remoteUser: null });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Cannot see infos as a random user', async () => {
        const loader = generateCanSeeAccountPrivateInfoLoader({ remoteUser: randomUser });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Can see infos if self', async () => {
        const loader = generateCanSeeAccountPrivateInfoLoader({ remoteUser: userWithPrivateInfo });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });

      it('Can see infos if collective admin', async () => {
        const loader = generateCanSeeAccountPrivateInfoLoader({ remoteUser: collectiveAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });

      it('Can see infos if host admin', async () => {
        const loader = generateCanSeeAccountPrivateInfoLoader({ remoteUser: hostAdmin });
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
          type: 'USER',
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
        await fakeMember({ role: 'BACKER', MemberCollectiveId: incognitoProfile.id, CollectiveId: collective.id });
        await incognitoProfile.addUserWithRole(userWithPrivateInfo, 'ADMIN');
      });

      it('Cannot see infos as unauthenticated', async () => {
        const loader = generateCanSeeAccountPrivateInfoLoader({ remoteUser: null });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Cannot see infos as a random user', async () => {
        const loader = generateCanSeeAccountPrivateInfoLoader({ remoteUser: randomUser });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Can see infos if self', async () => {
        const loader = generateCanSeeAccountPrivateInfoLoader({ remoteUser: userWithPrivateInfo });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });

      it('Cannot see infos if collective admin', async () => {
        const loader = generateCanSeeAccountPrivateInfoLoader({ remoteUser: collectiveAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Cannot see infos if host admin', async () => {
        const loader = generateCanSeeAccountPrivateInfoLoader({ remoteUser: hostAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });
    });

    describe('Account admins private info', () => {
      let organization, collective, orgAdminUsers, collectiveAdmin, hostAdmin;

      before(async () => {
        collective = await fakeCollective();
        organization = await fakeOrganization({ name: 'Organization' });
        orgAdminUsers = await Promise.all(times(3, fakeUser));
        collectiveAdmin = await fakeUser({ name: 'Collective Admin' });
        hostAdmin = await fakeUser({ name: 'Host Admin' });

        await fakeMember({ role: 'BACKER', MemberCollectiveId: organization.id, CollectiveId: collective.id });
        await Promise.all(orgAdminUsers.map(user => organization.addUserWithRole(user, 'ADMIN')));
        await collective.addUserWithRole(collectiveAdmin, 'ADMIN');
        await collective.host.addUserWithRole(hostAdmin, 'ADMIN');
      });

      it('returns true for the org itself', async () => {
        const loader = generateCanSeeAccountPrivateInfoLoader({ remoteUser: collectiveAdmin });
        const result = await loader.load(organization.id);
        expect(result).to.be.true;
      });

      it('can see admin infos as host admin if the organization is a contributor', async () => {
        const loader = generateCanSeeAccountPrivateInfoLoader({ remoteUser: hostAdmin });
        const result = await loader.loadMany(orgAdminUsers.map(u => u.CollectiveId));
        expect(result).to.deep.eq([true, true, true]);
      });

      it('can see host admin infos as a collective admin', async () => {
        const loader = generateCanSeeAccountPrivateInfoLoader({ remoteUser: collectiveAdmin });
        const result = await loader.load(collective.host.id);
        expect(result).to.be.true;
      });
    });
  });
});
