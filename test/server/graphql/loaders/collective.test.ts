import { expect } from 'chai';

import { types } from '../../../../server/constants/collectives';
import CollectiveLoaders from '../../../../server/graphql/loaders/collective';
import { fakeCollective, fakeMember, fakeUser } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('server/graphql/loaders/collective', () => {
  before(async () => {
    await resetTestDB();
  });

  describe('canSeePrivateInfo', () => {
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
        const loader = CollectiveLoaders.canSeePrivateInfo({ remoteUser: null });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Cannot see infos as a random user', async () => {
        const loader = CollectiveLoaders.canSeePrivateInfo({ remoteUser: randomUser });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Can see infos if self', async () => {
        const loader = CollectiveLoaders.canSeePrivateInfo({ remoteUser: userWithPrivateInfo });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });

      it('Can see infos if collective admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateInfo({ remoteUser: collectiveAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });

      it('Can see infos if host admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateInfo({ remoteUser: hostAdmin });
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
          type: types.USER,
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
        const loader = CollectiveLoaders.canSeePrivateInfo({ remoteUser: null });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Cannot see infos as a random user', async () => {
        const loader = CollectiveLoaders.canSeePrivateInfo({ remoteUser: randomUser });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Can see infos if self', async () => {
        const loader = CollectiveLoaders.canSeePrivateInfo({ remoteUser: userWithPrivateInfo });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });

      it('Cannot see infos if collective admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateInfo({ remoteUser: collectiveAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Cannot see infos if host admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateInfo({ remoteUser: hostAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });
    });
  });
});
