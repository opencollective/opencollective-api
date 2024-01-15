import { expect } from 'chai';
import gql from 'fake-tag';
import { times } from 'lodash';

import MemberRoles from '../../../../../server/constants/roles';
import {
  fakeCollective,
  fakeEmojiReaction,
  fakeHost,
  fakeMember,
  fakeOrganization,
  fakeProject,
  fakeUpdate,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const updateQuery = gql`
  query Update($accountSlug: String!, $slug: String!, $audience: UpdateAudience) {
    update(account: { slug: $accountSlug }, slug: $slug) {
      id
      publishedAt
      userCanSeeUpdate
      reactions
      userReactions
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

const addFakeUserMember = async (collective, role, collectiveData = undefined) => {
  const user = await fakeUser(undefined, collectiveData);
  await collective.addUserWithRole(user, role);
  return user;
};

const addRandomMemberUsers = (collective, count, role) => {
  return Promise.all(times(count, async () => addFakeUserMember(collective, role)));
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
          return fakeMember({ MemberCollectiveId: org.id, CollectiveId: collective.id, role: MemberRoles.BACKER });
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

  describe('reactions', () => {
    it('provides the number of reactions per emoji', async () => {
      const update = await fakeUpdate();
      await fakeEmojiReaction({ UpdateId: update.id, emoji: '👍️' });
      await fakeEmojiReaction({ UpdateId: update.id, emoji: '👍️' });
      await fakeEmojiReaction({ UpdateId: update.id, emoji: '🎉' });
      const response = await graphqlQueryV2(updateQuery, { accountSlug: update.collective.slug, slug: update.slug });
      expect(response.data.update.reactions).to.deep.eq({
        '👍️': 2,
        '🎉': 1,
      });
    });
  });

  describe('userReactions', () => {
    it('provides the user reactions', async () => {
      const update = await fakeUpdate();
      const user = await fakeUser();
      await fakeEmojiReaction({ UpdateId: update.id, emoji: '👍️', UserId: user.id });
      await fakeEmojiReaction({ UpdateId: update.id, emoji: '👍️' });
      await fakeEmojiReaction({ UpdateId: update.id, emoji: '🎉' });
      const response = await graphqlQueryV2(
        updateQuery,
        { accountSlug: update.collective.slug, slug: update.slug },
        user,
      );
      expect(response.data.update.userReactions).to.deep.eq(['👍️']);
    });
  });

  describe('userCanSeeUpdate', () => {
    let project, parentCollective, host, allUsers, backers, accountAdmins, hostAdmins, notAllowedUsers;

    before(async () => {
      host = await fakeHost();
      parentCollective = await fakeCollective({ HostCollectiveId: host.id });
      project = await fakeProject({ ParentCollectiveId: parentCollective.id });
      backers = await Promise.all([
        addFakeUserMember(project, 'BACKER', { name: 'Project backer' }),
        addFakeUserMember(parentCollective, 'BACKER', { name: 'Parent Collective admin' }),
      ]);
      accountAdmins = await Promise.all([
        addFakeUserMember(project, 'ADMIN', { name: 'Project admin' }),
        addFakeUserMember(parentCollective, 'ADMIN', { name: 'Parent Collective admin' }),
      ]);
      hostAdmins = await Promise.all([addFakeUserMember(host, 'ADMIN', { name: 'Host admin' })]);
      notAllowedUsers = await Promise.all([
        addFakeUserMember(project, 'FOLLOWER', { name: 'Project follower' }),
        addFakeUserMember(parentCollective, 'FOLLOWER', { name: 'Parent Collective follower' }),
        addFakeUserMember(host, 'FOLLOWER', { name: 'Host follower' }),
        fakeUser({ name: 'Random user' }), // Random user
        null, // Unauthenticated
      ]);
      allUsers = [...backers, ...accountAdmins, ...hostAdmins, ...notAllowedUsers];
    });

    it('always returns true for published public updates', async () => {
      const update = await fakeUpdate({ CollectiveId: project.id, publishedAt: new Date(), isPrivate: false });
      const queryParams = { accountSlug: update.collective.slug, slug: update.slug };

      for (const user of allUsers) {
        const response = await graphqlQueryV2(updateQuery, queryParams, user);
        expect(response.data.update.userCanSeeUpdate).to.be.true;
      }
    });

    it('returns false for unpublished updates if not allowed', async () => {
      const update = await fakeUpdate({ CollectiveId: project.id, publishedAt: null, isPrivate: false });
      const queryParams = { accountSlug: update.collective.slug, slug: update.slug };

      // Only admins can see unpublished updates
      for (const user of accountAdmins) {
        const response = await graphqlQueryV2(updateQuery, queryParams, user);
        expect(response.data.update.userCanSeeUpdate).to.be.true;
      }

      for (const user of [...notAllowedUsers, ...backers, ...hostAdmins]) {
        const response = await graphqlQueryV2(updateQuery, queryParams, user);
        expect(response.data.update.userCanSeeUpdate).to.be.false;
      }
    });

    it('returns false for published private updates if not allowed', async () => {
      const update = await fakeUpdate({ CollectiveId: project.id, publishedAt: new Date(), isPrivate: true });
      const queryParams = { accountSlug: update.collective.slug, slug: update.slug };

      for (const user of [...backers, ...accountAdmins, ...hostAdmins]) {
        const response = await graphqlQueryV2(updateQuery, queryParams, user);
        expect(response.data.update.userCanSeeUpdate).to.be.true;
      }

      for (const user of notAllowedUsers) {
        const response = await graphqlQueryV2(updateQuery, queryParams, user);
        expect(response.data.update.userCanSeeUpdate).to.be.false;
      }
    });

    describe('provides different results based on audience', () => {
      it('COLLECTIVE_ADMINS', async () => {
        const update = await fakeUpdate({
          CollectiveId: host.id,
          publishedAt: new Date(),
          isPrivate: true,
          notificationAudience: 'COLLECTIVE_ADMINS',
        });

        const queryParams = { accountSlug: update.collective.slug, slug: update.slug };

        for (const user of [...accountAdmins, ...hostAdmins]) {
          const response = await graphqlQueryV2(updateQuery, queryParams, user);
          expect(response.data.update.userCanSeeUpdate).to.be.true;
        }

        for (const user of [...backers, ...notAllowedUsers]) {
          const response = await graphqlQueryV2(updateQuery, queryParams, user);
          expect(response.data.update.userCanSeeUpdate).to.be.false;
        }
      });
    });
  });
});
