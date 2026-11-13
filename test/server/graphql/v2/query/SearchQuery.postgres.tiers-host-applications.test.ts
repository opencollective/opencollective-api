/**
 * PostgreSQL search provider: Tiers and Host Applications (opencollective#8943).
 *
 * These tests go through the GraphQL V2 `search` query with real PostgreSQL fixtures and never need an OpenSearch
 * cluster. Fixtures use made-up words so that tests don't match each other's rows.
 */

import { expect } from 'chai';
import gql from 'fake-tag';
import sinon from 'sinon';

import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import PlatformConstants from '../../../../../server/constants/platform';
import { idDecode, idEncode } from '../../../../../server/graphql/v2/identifiers';
import * as OpenSearchClientLib from '../../../../../server/lib/open-search/client';
import { Collective, HostApplication, Tier, User } from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeHostApplication,
  fakeOrganization,
  fakeProject,
  fakeTier,
  fakeUser,
  fakeUserToken,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetCaches, resetTestDB } from '../../../../utils';

const tiersSearchQuery = gql`
  query PostgresTiersSearch(
    $searchTerm: String!
    $account: AccountReferenceInput
    $host: AccountReferenceInput
    $limit: Int
    $offset: Int
  ) {
    search(searchTerm: $searchTerm, backend: POSTGRES, account: $account, host: $host) {
      results {
        tiers(limit: $limit, offset: $offset) {
          maxScore
          scores {
            id
            score
          }
          collection {
            totalCount
            offset
            nodes {
              id
              slug
            }
          }
        }
      }
    }
  }
`;

const hostApplicationsSearchQuery = gql`
  query PostgresHostApplicationsSearch(
    $searchTerm: String!
    $account: AccountReferenceInput
    $host: AccountReferenceInput
    $limit: Int
    $offset: Int
  ) {
    search(searchTerm: $searchTerm, backend: POSTGRES, account: $account, host: $host) {
      results {
        hostApplications(limit: $limit, offset: $offset) {
          maxScore
          scores {
            id
            score
          }
          collection {
            totalCount
            offset
            nodes {
              id
            }
          }
        }
      }
    }
  }
`;

type SearchVariables = {
  account?: { slug: string };
  host?: { slug: string };
  limit?: number;
  offset?: number;
};

const getTiers = async (searchTerm: string, variables: SearchVariables = {}, remoteUser: User = null) => {
  const result = await graphqlQueryV2(tiersSearchQuery, { searchTerm, ...variables }, remoteUser);
  expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
  return result.data.search.results.tiers;
};

const getTierIds = async (searchTerm: string, variables: SearchVariables = {}, remoteUser: User = null) =>
  (await getTiers(searchTerm, variables, remoteUser)).collection.nodes.map(node => idDecode(node.id, 'tier'));

const getHostApplications = async (searchTerm: string, variables: SearchVariables = {}, remoteUser: User = null) => {
  const result = await graphqlQueryV2(hostApplicationsSearchQuery, { searchTerm, ...variables }, remoteUser);
  expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
  return result.data.search.results.hostApplications;
};

const getHostApplicationIds = async (searchTerm: string, variables: SearchVariables = {}, remoteUser: User = null) =>
  (await getHostApplications(searchTerm, variables, remoteUser)).collection.nodes.map(node =>
    idDecode(node.id, 'host-application'),
  );

describe('server/graphql/v2/query/SearchQuery (PostgreSQL): tiers and host applications', () => {
  let sandbox: sinon.SinonSandbox;
  let randomUser: User, rootUser: User;

  before(async () => {
    await resetTestDB();
    await resetCaches(); // Search rate-limit counters are keyed by user ID, which the DB reset reuses
    randomUser = await fakeUser();
    rootUser = await fakeUser({ data: { isRoot: true } });
    const platform = await fakeOrganization({ id: PlatformConstants.PlatformCollectiveId, name: 'Platform' });
    await platform.addUserWithRole(rootUser, 'ADMIN');
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(OpenSearchClientLib, 'isOpenSearchConfigured').returns(false);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('tiers', () => {
    let host: Collective, collective: Collective, project: Collective;
    let goldTier: Tier, projectTier: Tier;

    before(async () => {
      host = await fakeActiveHost({ name: 'Marmoset Host', slug: 'marmoset-host' });
      collective = await fakeCollective({ name: 'Marmoset Collective', HostCollectiveId: host.id });
      project = await fakeProject({ ParentCollectiveId: collective.id, HostCollectiveId: host.id });
      goldTier = await fakeTier({
        CollectiveId: collective.id,
        name: 'Gilded Marmoset Patron',
        slug: 'gilded-marmoset-patron',
        description: 'Support our quetzalwatch program',
        longDescription: '<p>Receive a <b>hornbillcard</b>&nbsp;every month</p>',
      });
      projectTier = await fakeTier({ CollectiveId: project.id, name: 'Marmoset Project Friend' });
    });

    it('finds tiers by name words', async () => {
      expect(await getTierIds('gilded marmoset')).to.deep.eq([goldTier.id]);
      expect(await getTierIds('marmoset')).to.have.members([goldTier.id, projectTier.id]);
    });

    it('matches all the words across name, slug, description and long description', async () => {
      expect(await getTierIds('quetzalwatch')).to.deep.eq([goldTier.id]);
      expect(await getTierIds('hornbillcard patron')).to.deep.eq([goldTier.id]); // HTML stripped
      expect(await getTierIds('nbsp')).to.deep.eq([]);
      expect(await getTierIds('quetzalwatch unrelatedword')).to.deep.eq([]);
      expect(await getTierIds('GILDÉD')).to.deep.eq([goldTier.id]);
    });

    it('finds exact identifiers', async () => {
      for (const term of [String(goldTier.id), `#${goldTier.id}`, goldTier.publicId, idEncode(goldTier.id, 'tier')]) {
        expect(await getTierIds(term), term).to.include(goldTier.id);
      }
    });

    it('ranks exact names and slugs above word matches', async () => {
      const exactName = await fakeTier({ CollectiveId: collective.id, name: 'Okapi', slug: 'some-okapi-tier' });
      const exactSlug = await fakeTier({ CollectiveId: collective.id, name: 'Other Name', slug: 'okapi' });
      const wordMatch = await fakeTier({ CollectiveId: collective.id, name: 'Okapi Lovers Tier', slug: 'lovers' });
      const tiers = await getTiers('okapi');
      const ids = tiers.collection.nodes.map(n => idDecode(n.id, 'tier'));
      expect(ids.slice(0, 2)).to.have.members([exactName.id, exactSlug.id]);
      expect(ids[2]).to.eq(wordMatch.id);
      expect(tiers.scores[0].score).to.be.within(4000, 4499);
      expect(tiers.scores[2].score).to.be.within(3000, 3499);
      expect(tiers.maxScore).to.eq(tiers.scores[0].score);
      expect(await getTierIds('@okapi')).to.include(exactSlug.id);
    });

    it('returns exact totals, stable pages and an offset-independent maxScore', async () => {
      const tiers = await Promise.all([1, 2, 3].map(() => fakeTier({ CollectiveId: collective.id, name: 'Dugong' })));
      const all = await getTiers('dugong');
      expect(all.collection.totalCount).to.eq(3);
      expect(all.collection.nodes.map(n => idDecode(n.id, 'tier'))).to.deep.eq(
        tiers.map(t => t.id).sort((a, b) => b - a),
      );
      const pages = [
        ...(await getTierIds('dugong', { limit: 2, offset: 0 })),
        ...(await getTierIds('dugong', { limit: 2, offset: 2 })),
      ];
      expect(pages).to.deep.eq(all.collection.nodes.map(n => idDecode(n.id, 'tier')));
      const emptyPage = await getTiers('dugong', { limit: 2, offset: 10 });
      expect(emptyPage.collection.totalCount).to.eq(3);
      expect(emptyPage.collection.nodes).to.be.empty;
      expect(emptyPage.maxScore).to.eq(all.maxScore);
    });

    it('only returns live tiers of live, non-private accounts, for everyone including root', async () => {
      const deletedTier = await fakeTier({ CollectiveId: collective.id, name: 'Tapirus Deleted' });
      await deletedTier.destroy();
      const deletedAccount = await fakeCollective({ HostCollectiveId: host.id });
      await fakeTier({ CollectiveId: deletedAccount.id, name: 'Tapirus Of Deleted Account' });
      await deletedAccount.destroy();
      const privateAccount = await fakeCollective({ isPrivate: true });
      await fakeTier({ CollectiveId: privateAccount.id, name: 'Tapirus Of Private Account' });
      const visible = await fakeTier({ CollectiveId: collective.id, name: 'Tapirus Visible' });

      for (const user of [null, randomUser, rootUser]) {
        expect(await getTierIds('tapirus', {}, user)).to.deep.eq([visible.id]);
      }

      // Live changes
      await visible.update({ name: 'Renamed Pudu' });
      expect(await getTierIds('pudu')).to.deep.eq([visible.id]);
      await collective.update({ isPrivate: true });
      try {
        expect(await getTierIds('pudu', {}, rootUser)).to.deep.eq([]);
      } finally {
        await collective.update({ isPrivate: false });
      }
    });

    it('is public, including for OAuth tokens without any scope', async () => {
      const token = await fakeUserToken({ scope: [OAuthScopes.expenses], UserId: randomUser.id });
      const result = await oAuthGraphqlQueryV2(tiersSearchQuery, { searchTerm: 'quetzalwatch' }, token);
      expect(result.errors).to.not.exist;
      expect(result.data.search.results.tiers.collection.nodes.map(n => idDecode(n.id, 'tier'))).to.deep.eq([
        goldTier.id,
      ]);
    });

    it('scopes to the account and its children, to the host, and intersects both', async () => {
      const otherHostTier = await fakeTier({ name: 'Marmoset Elsewhere' }); // Another host and account
      expect(await getTierIds('marmoset')).to.have.members([goldTier.id, projectTier.id, otherHostTier.id]);
      expect(await getTierIds('marmoset', { account: { slug: collective.slug } })).to.have.members([
        goldTier.id,
        projectTier.id,
      ]);
      expect(await getTierIds('marmoset', { account: { slug: project.slug } })).to.deep.eq([projectTier.id]);
      expect(await getTierIds('marmoset', { host: { slug: host.slug } })).to.have.members([
        goldTier.id,
        projectTier.id,
      ]);
      expect(await getTierIds('marmoset', { account: { slug: project.slug }, host: { slug: host.slug } })).to.deep.eq([
        projectTier.id,
      ]);
      const otherHost = await fakeActiveHost();
      expect(await getTierIds('marmoset', { account: { slug: collective.slug }, host: { slug: otherHost.slug } })).to.be
        .empty;
    });
  });

  describe('host applications', () => {
    let host: Collective, collective: Collective, project: Collective, otherHost: Collective;
    let hostAdmin: User, collectiveAdmin: User, projectAdmin: User, otherHostAdmin: User;
    let application: HostApplication, projectApplication: HostApplication, otherApplication: HostApplication;

    before(async () => {
      hostAdmin = await fakeUser();
      collectiveAdmin = await fakeUser();
      projectAdmin = await fakeUser();
      otherHostAdmin = await fakeUser();
      host = await fakeActiveHost({ name: 'Ocelot Host', slug: 'ocelot-host', admin: hostAdmin });
      otherHost = await fakeActiveHost({ name: 'Other Ocelot Host', slug: 'other-ocelot-host', admin: otherHostAdmin });
      collective = await fakeCollective({ name: 'Ocelot Collective', HostCollectiveId: null, admin: collectiveAdmin });
      project = await fakeProject({ ParentCollectiveId: collective.id, HostCollectiveId: null, admin: projectAdmin });
      application = await fakeHostApplication({
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        message: 'We protect the endangered ocelotfriends of the Pantanal',
      });
      projectApplication = await fakeHostApplication({
        CollectiveId: project.id,
        HostCollectiveId: host.id,
        message: 'Project for ocelotfriends',
      });
      otherApplication = await fakeHostApplication({
        CollectiveId: collective.id,
        HostCollectiveId: otherHost.id,
        message: 'Also applying with ocelotfriends',
      });
    });

    it('finds applications by message words for administrators of the host or the applying account', async () => {
      expect(await getHostApplicationIds('endangered ocelotfriends', {}, hostAdmin)).to.deep.eq([application.id]);
      expect(await getHostApplicationIds('ocelotfriends', {}, hostAdmin)).to.have.members([
        application.id,
        projectApplication.id,
      ]);
      expect(await getHostApplicationIds('ocelotfriends', {}, collectiveAdmin)).to.have.members([
        application.id,
        otherApplication.id,
      ]);
      expect(await getHostApplicationIds('ocelotfriends', {}, projectAdmin)).to.deep.eq([projectApplication.id]);
      expect(await getHostApplicationIds('ocelotfriends', {}, otherHostAdmin)).to.deep.eq([otherApplication.id]);
      expect(await getHostApplicationIds('pantanal endangered', {}, hostAdmin)).to.deep.eq([application.id]);
      expect(await getHostApplicationIds('pantanal unrelatedword', {}, hostAdmin)).to.deep.eq([]);
    });

    it('returns nothing to users who cannot see the applications, without leaking totals or scores', async () => {
      for (const [label, user] of [
        ['unauthenticated', null],
        ['random user', randomUser],
      ] as const) {
        const results = await getHostApplications('ocelotfriends', {}, user);
        expect(results.collection.totalCount, label).to.eq(0);
        expect(results.collection.nodes, label).to.be.empty;
        expect(results.maxScore, label).to.eq(0);
        expect(await getHostApplicationIds(String(application.id), {}, user), label).to.be.empty;
      }
    });

    it('lets root search all the applications', async () => {
      expect(await getHostApplicationIds('ocelotfriends', {}, rootUser)).to.have.members([
        application.id,
        projectApplication.id,
        otherApplication.id,
      ]);
    });

    it('requires the applications OAuth scope', async () => {
      const query = (scope: OAuthScopes[]) =>
        fakeUserToken({ scope, UserId: hostAdmin.id }).then(token =>
          oAuthGraphqlQueryV2(hostApplicationsSearchQuery, { searchTerm: 'ocelotfriends' }, token),
        );

      const withoutScope = await query([OAuthScopes.account]);
      expect(withoutScope.errors).to.not.exist;
      expect(withoutScope.data.search.results.hostApplications.collection.totalCount).to.eq(0);
      const withScope = await query([OAuthScopes.applications]);
      expect(withScope.data.search.results.hostApplications.collection.totalCount).to.eq(2);
    });

    it('finds exact identifiers, only for permitted users', async () => {
      for (const term of [
        String(application.id),
        `#${application.id}`,
        application.publicId,
        idEncode(application.id, 'host-application'),
      ]) {
        const results = await getHostApplications(term, {}, hostAdmin);
        expect(
          results.collection.nodes.map(n => idDecode(n.id, 'host-application')),
          term,
        ).to.deep.eq([application.id]);
        expect(results.scores[0].score, term).to.be.within(5000, 5499);
        expect(await getHostApplicationIds(term, {}, otherHostAdmin), term).to.be.empty;
      }
    });

    it('scopes to the applying account and its children, to the host, and intersects both', async () => {
      const ids = (variables: SearchVariables) => getHostApplicationIds('ocelotfriends', variables, rootUser);
      expect(await ids({ account: { slug: collective.slug } })).to.have.members([
        application.id,
        projectApplication.id,
        otherApplication.id,
      ]);
      expect(await ids({ account: { slug: project.slug } })).to.deep.eq([projectApplication.id]);
      expect(await ids({ host: { slug: otherHost.slug } })).to.deep.eq([otherApplication.id]);
      expect(await ids({ account: { slug: collective.slug }, host: { slug: host.slug } })).to.have.members([
        application.id,
        projectApplication.id,
      ]);
      expect(await ids({ account: { slug: project.slug }, host: { slug: otherHost.slug } })).to.be.empty;
    });

    it('returns exact totals, stable pages and an offset-independent maxScore', async () => {
      const all = await getHostApplications('ocelotfriends', {}, rootUser);
      expect(all.collection.totalCount).to.eq(3);
      expect(all.collection.nodes.map(n => idDecode(n.id, 'host-application'))).to.deep.eq(
        [application.id, projectApplication.id, otherApplication.id].sort((a, b) => b - a),
      );
      const pages = [
        ...(await getHostApplicationIds('ocelotfriends', { limit: 2, offset: 0 }, rootUser)),
        ...(await getHostApplicationIds('ocelotfriends', { limit: 2, offset: 2 }, rootUser)),
      ];
      expect(pages).to.deep.eq(all.collection.nodes.map(n => idDecode(n.id, 'host-application')));
      const emptyPage = await getHostApplications('ocelotfriends', { limit: 2, offset: 10 }, rootUser);
      expect(emptyPage.collection.totalCount).to.eq(3);
      expect(emptyPage.collection.nodes).to.be.empty;
      expect(emptyPage.maxScore).to.eq(all.maxScore);
    });

    it('excludes deleted applications and applications of deleted or private accounts, even for root', async () => {
      const deleted = await fakeHostApplication({ HostCollectiveId: host.id, message: 'Serval deleted' });
      await deleted.destroy();
      const deletedAccount = await fakeCollective({ HostCollectiveId: null });
      await fakeHostApplication({ CollectiveId: deletedAccount.id, HostCollectiveId: host.id, message: 'Serval' });
      await deletedAccount.destroy();
      const privateAccount = await fakeCollective({ HostCollectiveId: null, isPrivate: true });
      await fakeHostApplication({ CollectiveId: privateAccount.id, HostCollectiveId: host.id, message: 'Serval' });
      const visible = await fakeHostApplication({ HostCollectiveId: host.id, message: 'Serval visible' });

      for (const user of [hostAdmin, rootUser]) {
        expect(await getHostApplicationIds('serval', {}, user)).to.deep.eq([visible.id]);
      }

      // Live changes
      await visible.update({ message: 'Renamed caracal' });
      expect(await getHostApplicationIds('caracal', {}, hostAdmin)).to.deep.eq([visible.id]);
      expect(await getHostApplicationIds('serval', {}, hostAdmin)).to.deep.eq([]);
    });
  });
});
