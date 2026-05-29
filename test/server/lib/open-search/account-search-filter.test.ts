import { expect } from 'chai';

import PlatformConstants from '../../../../server/constants/platform';
import MemberRoles from '../../../../server/constants/roles';
import {
  filterAccountSearchResults,
  getSearchableIndividualCollectiveIds,
} from '../../../../server/lib/open-search/account-search-filter';
import { sequelize } from '../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeMember,
  fakeOrganization,
  fakeUser,
} from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

const refreshCommunityMaterializedViews = async () => {
  await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityActivitySummary"');
};

describe('server/lib/open-search/account-search-filter', () => {
  let hostAdmin, host, collective, contributor, stranger;

  before(async () => {
    await resetTestDB();

    hostAdmin = await fakeUser();
    host = await fakeActiveHost({ admin: hostAdmin });
    collective = await fakeCollective({ HostCollectiveId: host.id });
    contributor = await fakeUser({}, { name: 'Allowed Contributor' });
    stranger = await fakeUser({}, { name: 'Hidden Stranger' });

    await fakeMember({
      CollectiveId: collective.id,
      MemberCollectiveId: contributor.CollectiveId,
      role: MemberRoles.BACKER,
    });

    await hostAdmin.populateRoles();
    await refreshCommunityMaterializedViews();
  });

  describe('getSearchableIndividualCollectiveIds', () => {
    it('returns nothing for unauthenticated users', async () => {
      const allowed = await getSearchableIndividualCollectiveIds([stranger.CollectiveId], null);
      expect(allowed.size).to.eq(0);
    });

    it('returns community individuals for host admins', async () => {
      const allowed = await getSearchableIndividualCollectiveIds(
        [contributor.CollectiveId, stranger.CollectiveId],
        hostAdmin,
      );
      expect(allowed.has(contributor.CollectiveId)).to.be.true;
      expect(allowed.has(stranger.CollectiveId)).to.be.false;
    });

    it('returns all candidates for root users', async () => {
      const rootUser = await fakeUser({ data: { isRoot: true } });
      const platform = await fakeOrganization({ name: 'Open Collective', id: PlatformConstants.PlatformCollectiveId });
      await platform.addUserWithRole(rootUser, 'ADMIN');
      await rootUser.populateRoles();

      const allowed = await getSearchableIndividualCollectiveIds(
        [contributor.CollectiveId, stranger.CollectiveId],
        rootUser,
      );
      expect(allowed.has(contributor.CollectiveId)).to.be.true;
      expect(allowed.has(stranger.CollectiveId)).to.be.true;
    });
  });

  describe('filterAccountSearchResults', () => {
    it('removes disallowed USER hits and keeps other account types', async () => {
      const result = await filterAccountSearchResults(
        {
          count: 3,
          maxScore: 10,
          hits: [
            {
              indexName: 'collectives',
              score: 10,
              id: String(collective.id),
              source: { id: collective.id, type: 'COLLECTIVE' },
              highlight: {},
            },
            {
              indexName: 'collectives',
              score: 8,
              id: String(contributor.CollectiveId),
              source: { id: contributor.CollectiveId, type: 'USER' },
              highlight: {},
            },
            {
              indexName: 'collectives',
              score: 7,
              id: String(stranger.CollectiveId),
              source: { id: stranger.CollectiveId, type: 'USER' },
              highlight: {},
            },
          ],
        },
        hostAdmin,
      );

      expect(result.hits).to.have.length(2);
      expect(result.hits.some(hit => hit.source['id'] === collective.id)).to.be.true;
      expect(result.hits.some(hit => hit.source['id'] === contributor.CollectiveId)).to.be.true;
      expect(result.hits.some(hit => hit.source['id'] === stranger.CollectiveId)).to.be.false;
      expect(result.count).to.eq(2);
    });
  });
});
