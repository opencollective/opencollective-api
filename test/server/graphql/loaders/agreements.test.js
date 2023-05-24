import { expect } from 'chai';

import { generateTotalAccountHostAgreementsLoader } from '../../../../server/graphql/loaders/agreements';
import Agreement from '../../../../server/models/Agreement';
import { fakeCollective, fakeHost } from '../../../test-helpers/fake-data';

describe('server/graphql/loaders/agreements', () => {
  describe('generateTotalAccountHostAgreementsLoader', () => {
    it('loads total agreement count', async () => {
      const host = await fakeHost();
      const account = await fakeCollective({ HostCollectiveId: host.id });

      await Agreement.create({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        title: 'Test 1',
      });

      await Agreement.create({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        title: 'Test 1 deleted',
        deletedAt: new Date(),
      });

      expect(await generateTotalAccountHostAgreementsLoader().load(account.id)).to.eql(1);
    });

    it('loads total agreement count for many', async () => {
      const host = await fakeHost();
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const account2 = await fakeCollective({ HostCollectiveId: host.id });

      await Agreement.create({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        title: 'Test 1',
      });

      await Agreement.create({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        title: 'Test 1 deleted',
        deletedAt: new Date(),
      });

      await Agreement.create({
        CollectiveId: account2.id,
        HostCollectiveId: host.id,
        title: 'Test 2',
      });

      await Agreement.create({
        CollectiveId: account2.id,
        HostCollectiveId: host.id,
        title: 'Test 3',
      });

      expect(await generateTotalAccountHostAgreementsLoader().loadMany([account.id, account2.id])).to.eql([1, 2]);
    });
  });
});
