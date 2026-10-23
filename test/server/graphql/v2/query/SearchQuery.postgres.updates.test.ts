/**
 * PostgreSQL search provider: Updates (opencollective#8938).
 *
 * These tests go through the GraphQL V2 `search` query with real PostgreSQL fixtures and never need an OpenSearch
 * cluster. Fixtures use made-up words so that tests don't match each other's records.
 */

import { expect } from 'chai';
import gql from 'fake-tag';
import sinon from 'sinon';

import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import PlatformConstants from '../../../../../server/constants/platform';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import * as OpenSearchClientLib from '../../../../../server/lib/open-search/client';
import { Collective, Update, User } from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeOrganization,
  fakeProject,
  fakeUpdate,
  fakeUser,
  fakeUserToken,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetCaches, resetTestDB } from '../../../../utils';

const updatesSearchQuery = gql`
  query PostgresUpdatesSearch(
    $searchTerm: String!
    $account: AccountReferenceInput
    $host: AccountReferenceInput
    $limit: Int
    $offset: Int
  ) {
    search(searchTerm: $searchTerm, backend: POSTGRES, account: $account, host: $host) {
      results {
        updates(limit: $limit, offset: $offset) {
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

type UpdatesSearchVariables = {
  account?: { slug: string };
  host?: { slug: string };
  limit?: number;
  offset?: number;
};

const searchUpdates = (searchTerm: string, variables: UpdatesSearchVariables = {}, remoteUser: User = null) =>
  graphqlQueryV2(updatesSearchQuery, { searchTerm, ...variables }, remoteUser);

const getUpdates = async (searchTerm: string, variables: UpdatesSearchVariables = {}, remoteUser: User = null) => {
  const result = await searchUpdates(searchTerm, variables, remoteUser);
  expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
  return result.data.search.results.updates;
};

const getUpdateSlugs = async (searchTerm: string, variables: UpdatesSearchVariables = {}, remoteUser = null) => {
  const updates = await getUpdates(searchTerm, variables, remoteUser);
  return updates.collection.nodes.map(node => node.slug);
};

describe('server/graphql/v2/query/SearchQuery (PostgreSQL, Updates)', () => {
  let sandbox: sinon.SinonSandbox;
  let collective: Collective;

  before(async () => {
    await resetTestDB();
    await resetCaches(); // Search rate-limit counters are keyed by user ID, which the DB reset reuses
    collective = await fakeCollective({ name: 'Marmoset Society', slug: 'marmoset-society' });
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(OpenSearchClientLib, 'isOpenSearchConfigured').returns(false);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('matching', () => {
    it('finds a published Update by title', async () => {
      const update = await fakeUpdate({
        CollectiveId: collective.id,
        title: 'Our Quetzalcoatl Gala',
        slug: 'our-gala',
        publishedAt: new Date(),
      });

      const updates = await getUpdates('quetzalcoatl');
      expect(updates.collection.totalCount).to.eq(1);
      expect(updates.collection.nodes).to.deep.eq([{ id: idEncode(update.id, 'update'), slug: update.slug }]);
      expect(updates.maxScore).to.eq(updates.scores[0].score);
    });

    it('matches the HTML body as plain text, the slug words, and requires all the words', async () => {
      const update = await fakeUpdate({
        CollectiveId: collective.id,
        title: 'Monthly News',
        slug: 'jacaranda-harvest-report',
        html: '<p>We planted <strong>baobab</strong>&nbsp;saplings</p><img src="https://example.com/okapiimage.png"/>',
        publishedAt: new Date(),
      });

      expect(await getUpdateSlugs('baobab saplings')).to.deep.eq([update.slug]);
      expect(await getUpdateSlugs('jacaranda harvest')).to.deep.eq([update.slug]);
      expect(await getUpdateSlugs('baobab monthly jacaranda')).to.deep.eq([update.slug]);
      expect(await getUpdateSlugs('baobab unrelatedword')).to.deep.eq([]);
      // Markup is not text
      expect(await getUpdateSlugs('strong')).to.deep.eq([]);
      expect(await getUpdateSlugs('okapiimage')).to.deep.eq([]);
      expect(await getUpdateSlugs('nbsp')).to.deep.eq([]);
    });

    it('ignores case and accents, both ways, and matches word forms', async () => {
      const update = await fakeUpdate({
        CollectiveId: collective.id,
        title: 'Crème Brûlée Fundraisers',
        html: '<p>Ærøskøbing celebrations</p>',
        publishedAt: new Date(),
      });

      expect(await getUpdateSlugs('creme brulee')).to.deep.eq([update.slug]);
      expect(await getUpdateSlugs('CRÈME BRÛLÉE')).to.deep.eq([update.slug]);
      expect(await getUpdateSlugs('aeroskobing celebration')).to.deep.eq([update.slug]);
      expect(await getUpdateSlugs('brulee fundraiser')).to.deep.eq([update.slug]);
    });

    it('finds exact identifiers', async () => {
      const update = await fakeUpdate({ CollectiveId: collective.id, publishedAt: new Date() });
      for (const term of [String(update.id), `#${update.id}`, update.publicId, idEncode(update.id, 'update')]) {
        expect(await getUpdateSlugs(term), term).to.include(update.slug);
      }
    });

    it('reflects live text changes', async () => {
      const update = await fakeUpdate({
        CollectiveId: collective.id,
        title: 'Draft Title',
        html: '<p>Iguanodon</p>',
        publishedAt: new Date(),
      });
      expect(await getUpdateSlugs('iguanodon')).to.deep.eq([update.slug]);
      await update.update({ html: '<p>Stegosaurus</p>', title: 'Renamed Ankylosaurus' });
      expect(await getUpdateSlugs('iguanodon')).to.deep.eq([]);
      expect(await getUpdateSlugs('stegosaurus')).to.deep.eq([update.slug]);
      expect(await getUpdateSlugs('ankylosaurus')).to.deep.eq([update.slug]);
      await update.destroy();
      expect(await getUpdateSlugs('stegosaurus')).to.deep.eq([]);
    });
  });

  describe('ranking alongside Accounts', () => {
    const mixedSearchQuery = gql`
      query PostgresMixedSearch(
        $searchTerm: String!
        $accountsLimit: Int
        $accountsOffset: Int
        $updatesLimit: Int
        $updatesOffset: Int
      ) {
        search(searchTerm: $searchTerm, backend: POSTGRES) {
          results {
            accounts(limit: $accountsLimit, offset: $accountsOffset) {
              maxScore
              highlights
              scores {
                id
                score
              }
              collection {
                totalCount
              }
            }
            updates(limit: $updatesLimit, offset: $updatesOffset) {
              maxScore
              highlights
              scores {
                id
                score
              }
              collection {
                totalCount
              }
            }
          }
        }
      }
    `;

    let exactAccount: Collective, partialAccount: Collective, exactUpdate: Update, wordsUpdate: Update;

    before(async () => {
      // Created in an order that differs from the expected ranking
      partialAccount = await fakeCollective({ name: 'Friends of the Gharial', slug: 'friends-gharial' });
      wordsUpdate = await fakeUpdate({
        CollectiveId: partialAccount.id,
        title: 'News',
        html: '<p>The gharial is back</p>',
        publishedAt: new Date(),
      });
      exactUpdate = await fakeUpdate({ CollectiveId: partialAccount.id, title: 'Gharial', publishedAt: new Date() });
      exactAccount = await fakeCollective({ name: 'Gharial', slug: 'some-reptile-group' });
    });

    const search = async (variables: Record<string, number> = {}) => {
      const result = await graphqlQueryV2(mixedSearchQuery, { searchTerm: 'gharial', ...variables });
      expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
      return result.data.search.results;
    };

    it('ranks exact Account name > exact Update title > partial Account name', async () => {
      const { accounts, updates } = await search();
      const ranked = [...accounts.scores, ...updates.scores].sort((a, b) => b.score - a.score).map(s => s.id);
      expect(ranked).to.deep.eq([
        idEncode(exactAccount.id, 'account'),
        idEncode(exactUpdate.id, 'update'),
        idEncode(partialAccount.id, 'account'),
        idEncode(wordsUpdate.id, 'update'),
      ]);

      // Groups are ordered by maxScore; no highlights are needed for any of this
      expect(accounts.maxScore).to.be.above(updates.maxScore);
      for (const group of [accounts, updates]) {
        Object.values(group.highlights).forEach(
          (highlight: { fields?: unknown }) => expect(highlight.fields).to.not.exist,
        );
      }
    });

    it('keeps the same scores, exact totals and offset-independent maxScores on later pages', async () => {
      const firstPages = await search({ accountsLimit: 1, updatesLimit: 1 });
      const laterPages = await search({ accountsLimit: 1, accountsOffset: 1, updatesLimit: 1, updatesOffset: 1 });
      const emptyPages = await search({ accountsLimit: 1, accountsOffset: 10, updatesLimit: 1, updatesOffset: 10 });

      for (const pages of [firstPages, laterPages, emptyPages]) {
        expect(pages.accounts.collection.totalCount).to.eq(2);
        expect(pages.updates.collection.totalCount).to.eq(2);
        expect(pages.accounts.maxScore).to.eq(firstPages.accounts.scores[0].score);
        expect(pages.updates.maxScore).to.eq(firstPages.updates.scores[0].score);
      }

      // A later Account page still ranks below the first Update page, and Update pages are stable
      expect(laterPages.accounts.scores).to.deep.eq([
        { id: idEncode(partialAccount.id, 'account'), score: laterPages.accounts.scores[0].score },
      ]);
      expect(laterPages.accounts.scores[0].score).to.be.below(firstPages.updates.scores[0].score);
      expect(firstPages.updates.scores[0].id).to.eq(idEncode(exactUpdate.id, 'update'));
      expect(laterPages.updates.scores[0].id).to.eq(idEncode(wordsUpdate.id, 'update'));
      expect(emptyPages.accounts.scores).to.be.empty;
      expect(emptyPages.updates.scores).to.be.empty;
    });

    it('breaks ties by descending ID, consistently across pages', async () => {
      const tied = [];
      for (let i = 0; i < 3; i++) {
        tied.push(await fakeUpdate({ CollectiveId: partialAccount.id, title: 'Tiedword', publishedAt: new Date() }));
      }

      const expected = [...tied].reverse().map(u => u.slug);
      expect(await getUpdateSlugs('tiedword')).to.deep.eq(expected);
      const pages = [
        ...(await getUpdateSlugs('tiedword', { limit: 2, offset: 0 })),
        ...(await getUpdateSlugs('tiedword', { limit: 2, offset: 2 })),
      ];
      expect(pages).to.deep.eq(expected);
    });
  });

  describe('eligibility and permissions', () => {
    let hostAdmin: User, collectiveAdmin: User, projectAdmin: User, randomUser: User, rootUser: User;
    let host: Collective, hosted: Collective, project: Collective;
    let published: Update, privatePublished: Update, draft: Update, projectDraft: Update;

    before(async () => {
      hostAdmin = await fakeUser();
      collectiveAdmin = await fakeUser();
      projectAdmin = await fakeUser();
      randomUser = await fakeUser();
      rootUser = await fakeUser({ data: { isRoot: true } });
      const platform = await fakeOrganization({ id: PlatformConstants.PlatformCollectiveId, name: 'Platform' });
      await platform.addUserWithRole(rootUser, 'ADMIN');

      host = await fakeActiveHost({ name: 'Tapir Host', slug: 'tapir-host', admin: hostAdmin });
      hosted = await fakeCollective({ slug: 'tapir-collective', HostCollectiveId: host.id, admin: collectiveAdmin });
      project = await fakeProject({ slug: 'tapir-project', ParentCollectiveId: hosted.id, admin: projectAdmin });

      const now = new Date();
      published = await fakeUpdate({
        CollectiveId: hosted.id,
        slug: 'tapir-published',
        title: 'Tapir Published',
        html: '<p>Common</p>',
        publishedAt: now,
      });
      privatePublished = await fakeUpdate({
        CollectiveId: hosted.id,
        slug: 'tapir-private',
        title: 'Tapir Private',
        html: '<p>Secretprivateword</p>',
        isPrivate: true,
        publishedAt: now,
      });
      draft = await fakeUpdate({
        CollectiveId: hosted.id,
        slug: 'tapir-draft',
        title: 'Tapir Draft',
        html: '<p>Secretdraftword</p>',
        publishedAt: null,
      });
      projectDraft = await fakeUpdate({
        CollectiveId: project.id,
        slug: 'tapir-project-draft',
        title: 'Tapir Project Draft',
        publishedAt: null,
      });

      // Never searchable, even for root
      const privateAccount = await fakeCollective({ isPrivate: true });
      const hiddenAccount = await fakeCollective({ data: { hideFromSearch: true } });
      const deletedAccount = await fakeCollective();
      for (const account of [privateAccount, hiddenAccount, deletedAccount]) {
        await fakeUpdate({ CollectiveId: account.id, title: 'Tapir Ineligible', publishedAt: now });
      }
      await deletedAccount.destroy();
    });

    it('applies publication, Account and administrator rules', async () => {
      const everything = [published, privatePublished, draft, projectDraft].map(u => u.slug);
      const expectations: Array<[string, User | null, string[]]> = [
        ['unauthenticated', null, [published.slug]],
        ['random user', randomUser, [published.slug]],
        ['project admin', projectAdmin, [published.slug, projectDraft.slug]],
        ['collective admin (and parent of the project)', collectiveAdmin, everything],
        // Host administrators can see the published Updates of their hosted Accounts, never their drafts
        ['host admin', hostAdmin, [published.slug, privatePublished.slug]],
        ['root', rootUser, everything],
      ];

      for (const [label, user, expected] of expectations) {
        const updates = await getUpdates('tapir', {}, user);
        expect(
          updates.collection.nodes.map(n => n.slug),
          label,
        ).to.have.members(expected);
        expect(updates.collection.totalCount, label).to.eq(expected.length);
      }
    });

    it('never lets inaccessible text affect matching, totals or scores', async () => {
      for (const word of ['secretprivateword', 'secretdraftword', 'tapir secretdraftword']) {
        for (const user of [null, randomUser, projectAdmin]) {
          const updates = await getUpdates(word, {}, user);
          expect(updates.collection.totalCount, word).to.eq(0);
          expect(updates.maxScore, word).to.eq(0);
        }
      }

      // Host administrators match the private published Update, but not the draft
      expect((await getUpdates('secretprivateword', {}, hostAdmin)).collection.totalCount).to.eq(1);
      for (const word of ['secretdraftword', 'tapir secretdraftword']) {
        const updates = await getUpdates(word, {}, hostAdmin);
        expect(updates.collection.totalCount, word).to.eq(0);
        expect(updates.maxScore, word).to.eq(0);
        expect((await getUpdates(word, {}, collectiveAdmin)).collection.totalCount, word).to.eq(1);
      }

      // An exact title that only matches a draft does not raise the public maxScore
      const publicResult = await getUpdates('tapir draft');
      const adminResult = await getUpdates('tapir draft', {}, collectiveAdmin);
      expect(publicResult.collection.totalCount).to.eq(0);
      expect(adminResult.collection.nodes[0].slug).to.eq(draft.slug);
      expect(adminResult.maxScore).to.be.within(4000, 4499);
    });

    it('does not let OAuth tokens without the updates scope see restricted Updates', async () => {
      const query = (scope: OAuthScopes[]) =>
        fakeUserToken({ scope, UserId: hostAdmin.id }).then(token =>
          oAuthGraphqlQueryV2(updatesSearchQuery, { searchTerm: 'tapir' }, token),
        );

      const withoutScope = await query([OAuthScopes.expenses]);
      expect(withoutScope.errors).to.not.exist;
      expect(withoutScope.data.search.results.updates.collection.nodes.map(n => n.slug)).to.deep.eq([published.slug]);
      const withScope = await query([OAuthScopes.updates]);
      expect(withScope.data.search.results.updates.collection.nodes.map(n => n.slug)).to.have.members([
        published.slug,
        privatePublished.slug,
      ]);
    });

    it('reflects live publication and visibility changes', async () => {
      const update = await fakeUpdate({ CollectiveId: hosted.id, title: 'Liveword', publishedAt: null });
      expect(await getUpdateSlugs('liveword')).to.deep.eq([]);
      await update.update({ publishedAt: new Date() });
      expect(await getUpdateSlugs('liveword')).to.deep.eq([update.slug]);
      await update.update({ isPrivate: true });
      expect(await getUpdateSlugs('liveword')).to.deep.eq([]);
      expect(await getUpdateSlugs('liveword', {}, collectiveAdmin)).to.deep.eq([update.slug]);
      await hosted.update({ isPrivate: true });
      try {
        expect(await getUpdateSlugs('liveword', {}, rootUser)).to.deep.eq([]);
      } finally {
        await hosted.update({ isPrivate: false });
      }
    });

    it('scopes Updates to the account and its children', async () => {
      expect(await getUpdateSlugs('tapir', { account: { slug: project.slug } }, rootUser)).to.deep.eq([
        projectDraft.slug,
      ]);
      expect(await getUpdateSlugs('tapir', { account: { slug: hosted.slug } }, rootUser)).to.have.members([
        published.slug,
        privatePublished.slug,
        draft.slug,
        projectDraft.slug,
      ]);
    });

    it('scopes Updates to the host, and intersects account and host scopes', async () => {
      expect(await getUpdateSlugs('tapir', { host: { slug: host.slug } })).to.deep.eq([published.slug]);
      expect(
        await getUpdateSlugs('tapir', { host: { slug: host.slug }, account: { slug: project.slug } }, rootUser),
      ).to.deep.eq([projectDraft.slug]);
      const otherHost = await fakeActiveHost({ slug: 'tapir-other-host' });
      expect(await getUpdateSlugs('tapir', { host: { slug: otherHost.slug }, account: { slug: hosted.slug } })).to.be
        .empty;
    });
  });
});
