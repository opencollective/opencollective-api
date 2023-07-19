import { expect } from 'chai';

import { generateTotalAccountHostAgreementsLoader } from '../../../../server/graphql/loaders/agreements.js';
import Agreement from '../../../../server/models/Agreement.js';
import { fakeCollective, fakeHost } from '../../../test-helpers/fake-data.js';

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
      const account2Parent = await fakeCollective({ HostCollectiveId: host.id });
      const account2 = await fakeCollective({ HostCollectiveId: host.id, ParentCollectiveId: account2Parent.id });

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
        CollectiveId: account2Parent.id,
        HostCollectiveId: host.id,
        title: 'Test 2 parent',
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

      expect(
        await generateTotalAccountHostAgreementsLoader().loadMany([account.id, account2Parent.id, account2.id]),
      ).to.eql([1, 1, 3]);
    });
  });
});
