import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { times } from 'lodash';

import {
  fakeCollective,
  fakeHost,
  fakeMember,
  fakeOrganization,
  fakeUpdate,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const updateQuery = gqlV2/* GraphQL */ `
  query Update($accountSlug: String!, $slug: String!, $audience: UpdateAudience) {
    update(account: { slug: $accountSlug }, slug: $slug) {
      id
      publishedAt
      audienceStats(audience: $audience) {
        total
        individuals
        organizations
        coreContributors
        hosted
      }
    }
  }
`;

const addRandomMemberUsers = (collective, count, role) => {
  return Promise.all(
    times(count, async () => {
      const user = await fakeUser();
      await collective.addUserWithRole(user, role);
      return user;
    }),
  );
};

describe('server/graphql/v2/query/UpdateQuery', () => {
  describe('audienceStats', () => {
    it('returns null if not logged in as admin', async () => {
      const update = await fakeUpdate({ publishedAt: null });
      const randomUser = await fakeUser();
      const queryParams = { accountSlug: update.collective.slug, slug: update.slug };
      const response = await graphqlQueryV2(updateQuery, queryParams);
      expect(response.data.update.audienceStats).to.be.null;

      const responseAsRandomUser = await graphqlQueryV2(updateQuery, queryParams, randomUser);
      expect(responseAsRandomUser.data.update.audienceStats).to.be.null;
    });

    it('returns null if not logged if already published', async () => {
      const admin = await fakeUser();
      const collective = await fakeCollective({ admin });
      const update = await fakeUpdate({ CollectiveId: collective.id, publishedAt: new Date() });
      const queryParams = { accountSlug: collective.slug, slug: update.slug };
      const response = await graphqlQueryV2(updateQuery, queryParams, admin);
      expect(response.data.update.audienceStats).to.be.null;
    });

    it('for an update on empty collective', async () => {
      const admin = await fakeUser();
      const collective = await fakeCollective();
      await collective.addUserWithRole(admin, 'ADMIN');
      const update = await fakeUpdate({ CollectiveId: collective.id, publishedAt: null });
      const queryParams = { accountSlug: collective.slug, slug: update.slug };
      const response = await graphqlQueryV2(updateQuery, queryParams, admin);

      response.errors && console.error(response.errors);
      const audienceStats = response.data.update.audienceStats;
      expect(audienceStats).to.not.be.null;
      // Should have only the collective admin
      expect(audienceStats.total).to.eq(1);
      expect(audienceStats.organizations).to.eq(0);
    });

    it('returns the breakdown for a public update', async () => {
      const admin = await fakeUser();
      const collective = await fakeCollective();
      await collective.addUserWithRole(admin, 'ADMIN');
      const backerUsers = await addRandomMemberUsers(collective, 3, 'BACKER');
      const backerOrgs = await Promise.all(times(4, () => fakeOrganization()));
      const nbAdminsPerOrg = 2;
      await Promise.all(
        backerOrgs.map(async org => {
          await addRandomMemberUsers(org, nbAdminsPerOrg, 'ADMIN');
          return fakeMember({ MemberCollectiveId: org.id, CollectiveId: collective.id, role: 'BACKER' });
        }),
      );

      const update = await fakeUpdate({ CollectiveId: collective.id, publishedAt: null, isPrivate: false });
      const queryParams = { accountSlug: collective.slug, slug: update.slug };
      const response = await graphqlQueryV2(updateQuery, queryParams, admin);
      const audienceStats = response.data.update.audienceStats;
      expect(audienceStats).to.not.be.null;
      // Should have only the collective admin
      expect(audienceStats.organizations).to.eq(backerOrgs.length);
      expect(audienceStats.coreContributors).to.eq(1);
      expect(audienceStats.individuals).to.eq(backerUsers.length);
      expect(audienceStats.total).to.eq(1 + backerUsers.length + backerOrgs.length * nbAdminsPerOrg);
    });

    it('returns number of hosted collective for hosts', async () => {
      const admin = await fakeUser();
      const host = await fakeHost();
      await host.addUserWithRole(admin, 'ADMIN');
      const hostedCollective = await fakeCollective({ HostCollectiveId: host.id, approvedAt: new Date() });
      const hostedCollectiveAdmins = await addRandomMemberUsers(hostedCollective, 3, 'ADMIN');
      const hostBackers = await addRandomMemberUsers(host, 5, 'BACKER');
      const update = await fakeUpdate({ CollectiveId: host.id, publishedAt: null, notificationAudience: null });

      // Default audience (ALL)
      let queryParams = { accountSlug: host.slug, slug: update.slug, audience: undefined };
      let response = await graphqlQueryV2(updateQuery, queryParams, admin);
      let audienceStats = response.data.update.audienceStats;

      expect(audienceStats).to.not.be.null;

      // Should have only the collective admin
      expect(audienceStats.total).to.eq(1 + hostedCollectiveAdmins.length + hostBackers.length);
      expect(audienceStats.organizations).to.eq(0);
      expect(audienceStats.hosted).to.eq(1);

      // Force audience (ALL)
      queryParams = { accountSlug: host.slug, slug: update.slug, audience: 'ALL' };
      response = await graphqlQueryV2(updateQuery, queryParams, admin);
      audienceStats = response.data.update.audienceStats;
      expect(audienceStats).to.not.be.null;
      // Should have only the collective admin
      expect(audienceStats.total).to.eq(1 + hostedCollectiveAdmins.length + hostBackers.length);
      expect(audienceStats.coreContributors).to.eq(1);
      expect(audienceStats.individuals).to.eq(hostBackers.length);
      expect(audienceStats.organizations).to.eq(0);
      expect(audienceStats.hosted).to.eq(1);

      // Force audience (COLLECTIVE_ADMINS)
      queryParams = { accountSlug: host.slug, slug: update.slug, audience: 'COLLECTIVE_ADMINS' };
      response = await graphqlQueryV2(updateQuery, queryParams, admin);
      audienceStats = response.data.update.audienceStats;
      expect(audienceStats).to.not.be.null;
      // Should have only the collective admin
      expect(audienceStats.total).to.eq(1 + hostedCollectiveAdmins.length);
      expect(audienceStats.individuals).to.eq(0);
      expect(audienceStats.organizations).to.eq(0);
      expect(audienceStats.hosted).to.eq(1);

      // Force audience (FINANCIAL_CONTRIBUTORS)
      queryParams = { accountSlug: host.slug, slug: update.slug, audience: 'FINANCIAL_CONTRIBUTORS' };
      response = await graphqlQueryV2(updateQuery, queryParams, admin);
      audienceStats = response.data.update.audienceStats;
      expect(audienceStats).to.not.be.null;
      // Should have only the collective admin
      expect(audienceStats.total).to.eq(1 + hostBackers.length);
      expect(audienceStats.organizations).to.eq(0);
      expect(audienceStats.coreContributors).to.eq(1);
      expect(audienceStats.individuals).to.eq(hostBackers.length);
      expect(audienceStats.hosted).to.eq(0);
    });
  });
});
