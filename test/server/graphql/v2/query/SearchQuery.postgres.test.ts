/**
 * PostgreSQL search provider (opencollective#8937).
 *
 * These tests go through the GraphQL V2 `search` query with real PostgreSQL fixtures. They never need an
 * OpenSearch cluster: OpenSearch is reported as not configured unless a test explicitly fakes it.
 *
 * Fixtures use made-up words so that tests don't match each other's accounts.
 */

import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import { times } from 'lodash';
import { QueryTypes } from 'sequelize';
import sinon from 'sinon';

import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import PlatformConstants from '../../../../../server/constants/platform';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import * as OpenSearchClientLib from '../../../../../server/lib/open-search/client';
import { formatIndexNameForOpenSearch } from '../../../../../server/lib/open-search/common';
import { OpenSearchIndexName } from '../../../../../server/lib/open-search/constants';
import { Collective, sequelize, User } from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeOrganization,
  fakeProject,
  fakeUser,
  fakeUserToken,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetTestDB } from '../../../../utils';

const accountsSearchQuery = gql`
  query PostgresAccountsSearch(
    $searchTerm: String!
    $backend: SearchBackend
    $account: AccountReferenceInput
    $host: AccountReferenceInput
    $limit: Int
    $offset: Int
    $type: AccountType
    $isHost: Boolean
    $tags: [String]
    $timeout: Int
  ) {
    search(searchTerm: $searchTerm, backend: $backend, account: $account, host: $host, timeout: $timeout) {
      results {
        accounts(limit: $limit, offset: $offset, type: $type, isHost: $isHost, tags: $tags) {
          maxScore
          scores {
            id
            score
          }
          collection {
            totalCount
            limit
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

type AccountsSearchVariables = {
  backend?: string;
  account?: { slug: string };
  host?: { slug: string };
  limit?: number;
  offset?: number;
  type?: string;
  isHost?: boolean;
  tags?: string[];
  timeout?: number;
};

const searchAccounts = (searchTerm: string, variables: AccountsSearchVariables = {}, remoteUser: User = null) =>
  graphqlQueryV2(accountsSearchQuery, { searchTerm, backend: 'POSTGRES', ...variables }, remoteUser);

/** Returns the accounts results, failing on errors */
const getAccounts = async (searchTerm: string, variables: AccountsSearchVariables = {}, remoteUser: User = null) => {
  const result = await searchAccounts(searchTerm, variables, remoteUser);
  expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
  return result.data.search.results.accounts;
};

const getSlugs = async (searchTerm: string, variables: AccountsSearchVariables = {}, remoteUser: User = null) => {
  const accounts = await getAccounts(searchTerm, variables, remoteUser);
  return accounts.collection.nodes.map(node => node.slug);
};

describe('server/graphql/v2/query/SearchQuery (PostgreSQL)', () => {
  let sandbox: sinon.SinonSandbox;

  before(async () => {
    await resetTestDB();
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(OpenSearchClientLib, 'isOpenSearchConfigured').returns(false);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('provider selection', () => {
    let collective: Collective;

    before(async () => {
      collective = await fakeCollective({ name: 'Zanzibar Gardening Club', slug: 'zanzibar-gardening' });
    });

    it('finds an Account by name without an OpenSearch cluster', async () => {
      const accounts = await getAccounts('zanzibar');
      expect(accounts.collection.totalCount).to.eq(1);
      expect(accounts.collection.nodes.map(n => n.slug)).to.deep.eq([collective.slug]);
      expect(accounts.scores).to.deep.eq([{ id: idEncode(collective.id, 'account'), score: accounts.scores[0].score }]);
      expect(accounts.maxScore).to.eq(accounts.scores[0].score);
    });

    it('uses OpenSearch when the backend is omitted, which requires OpenSearch to be configured', async () => {
      const result = await graphqlQueryV2(accountsSearchQuery, { searchTerm: 'zanzibar' });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/OpenSearch is not running|temporarily unavailable/);
    });

    it('can mix providers in the same request with aliases', async () => {
      // A fake OpenSearch that returns a single, fixed account
      sandbox.restore();
      sandbox = sinon.createSandbox();
      sandbox.stub(OpenSearchClientLib, 'isOpenSearchConfigured').returns(true);
      const otherAccount = await fakeCollective({ name: 'Unrelated OpenSearch Result' });
      sandbox.stub(OpenSearchClientLib, 'getOpenSearchClient').returns({
        search: async () => ({
          body: {
            hits: {
              total: { value: 1, relation: 'eq' },
              // eslint-disable-next-line camelcase
              max_score: 42,
              hits: [
                {
                  _index: formatIndexNameForOpenSearch(OpenSearchIndexName.COLLECTIVES),
                  _id: String(otherAccount.id),
                  _score: 42,
                  _source: { id: otherAccount.id },
                },
              ],
            },
          },
        }),
      } as unknown as ReturnType<typeof OpenSearchClientLib.getOpenSearchClient>);

      const result = await graphqlQueryV2(
        gql`
          query MixedProviders($searchTerm: String!) {
            os: search(searchTerm: $searchTerm, backend: OPENSEARCH) {
              results {
                accounts {
                  maxScore
                  collection {
                    totalCount
                    nodes {
                      slug
                    }
                  }
                }
              }
            }
            pg: search(searchTerm: $searchTerm, backend: POSTGRES) {
              results {
                accounts {
                  collection {
                    totalCount
                    nodes {
                      slug
                    }
                  }
                }
              }
            }
          }
        `,
        { searchTerm: 'zanzibar' },
      );

      expect(result.errors).to.not.exist;
      expect(result.data.os.results.accounts.maxScore).to.eq(42);
      expect(result.data.os.results.accounts.collection.nodes.map(n => n.slug)).to.deep.eq([otherAccount.slug]);
      expect(result.data.pg.results.accounts.collection.nodes.map(n => n.slug)).to.deep.eq([collective.slug]);
    });

    it('returns a clear error for an entity that is not supported yet, without failing the other entities', async () => {
      const result = await graphqlQueryV2(
        gql`
          query UnsupportedEntity($searchTerm: String!) {
            search(searchTerm: $searchTerm, backend: POSTGRES) {
              results {
                accounts {
                  collection {
                    totalCount
                  }
                }
                comments {
                  collection {
                    totalCount
                  }
                }
              }
            }
          }
        `,
        { searchTerm: 'zanzibar' },
      );

      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.eq('Searching comments is not supported by the PostgreSQL search yet');
      expect(result.errors[0].extensions.code).to.eq('SearchEntityNotSupported');
      expect(result.errors[0].path).to.deep.eq(['search', 'results', 'comments']);
      expect(result.data.search.results.accounts.collection.totalCount).to.eq(1);
    });

    it('applies the existing preview access in production', async () => {
      sandbox.stub(config, 'env').value('production');
      const result = await searchAccounts('zanzibar', {}, await fakeUser());
      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.eq('Forbidden');
    });
  });

  describe('input', () => {
    let shortSlugAccount: Collective;

    before(async () => {
      shortSlugAccount = await fakeCollective({ name: 'Quokkaville Q', slug: 'q' });
    });

    it('returns no results for an empty input', async () => {
      for (const term of ['', '   ']) {
        const accounts = await getAccounts(term);
        expect(accounts.collection.totalCount).to.eq(0);
        expect(accounts.collection.nodes).to.be.empty;
        expect(accounts.maxScore).to.eq(0);
      }
    });

    it('keeps exact lookups for short input', async () => {
      expect(await getSlugs('q')).to.deep.eq([shortSlugAccount.slug]);
      expect(await getSlugs('@q')).to.deep.eq([shortSlugAccount.slug]);
    });

    it('rejects input longer than 200 characters', async () => {
      expect((await getAccounts('a'.repeat(200))).collection.totalCount).to.eq(0);
      const result = await searchAccounts('a'.repeat(201));
      expect(result.errors[0].message).to.eq('The search term is too long (maximum 200 characters)');
    });

    it('rejects input with more than 12 words', async () => {
      expect((await getAccounts(times(12, i => `w${i}`).join(' '))).collection.totalCount).to.eq(0);
      const result = await searchAccounts(times(13, i => `w${i}`).join(' '));
      expect(result.errors[0].message).to.eq('The search term has too many words (maximum 12)');
    });

    it('rejects pages of more than 50 results or beyond offset 5000', async () => {
      expect((await getAccounts('quokkaville', { limit: 50, offset: 5000 })).collection.totalCount).to.eq(1);

      let result = await searchAccounts('quokkaville', { limit: 51 });
      expect(result.errors[0].message).to.eq('The search limit must be between 0 and 50');
      result = await searchAccounts('quokkaville', { offset: 5001 });
      expect(result.errors[0].message).to.match(/only available up to offset 5000. Narrow your search/);
      expect(result.errors[0].extensions.code).to.eq('SearchOffsetTooDeep');
    });

    it('rejects invalid timeouts', async () => {
      const result = await searchAccounts('quokkaville', { timeout: 60_000 });
      expect(result.errors[0].message).to.eq('The search timeout must be between 100 and 30000 ms');
    });

    it('treats SQL and tsquery syntax as ordinary input', async () => {
      for (const term of [
        `quokkaville'; DROP TABLE "Collectives"; --`,
        'quokkaville & !(foo | bar):*',
        `quokkaville\\' OR 1=1`,
        '<-> :* & | ! ( )',
      ]) {
        const result = await searchAccounts(term);
        expect(result.errors, term).to.not.exist;
      }

      expect(await getSlugs(`quokkaville'; DROP TABLE "Collectives"; --`)).to.deep.eq([]);
      expect(await getSlugs('quokkaville & !(q):*')).to.deep.eq([shortSlugAccount.slug]);
    });
  });

  describe('matching', () => {
    let accented: Collective, stemmed: Collective, described: Collective, tagged: Collective, website: Collective;

    before(async () => {
      accented = await fakeCollective({ name: 'Crème Brûlée Ærøskøbing', slug: 'creme-brulee-xyz' });
      stemmed = await fakeCollective({ name: 'Wombatting Collectives', slug: 'wombat-collectives' });
      described = await fakeCollective({
        name: 'Plain Name',
        slug: 'plain-name-described',
        description: 'Supporting narwhal conservation',
        longDescription: '<p>We protect <b>kelpforest</b>&nbsp;habitats</p>',
      });
      tagged = await fakeCollective({ name: 'Tagged One', slug: 'tagged-one', tags: ['axolotlcare'] });
      website = await fakeCollective({ name: 'Site One', slug: 'site-one', website: 'https://pangolinweb.org' });
    });

    it('ignores case and accents, both ways', async () => {
      expect(await getSlugs('creme brulee')).to.deep.eq([accented.slug]);
      expect(await getSlugs('CRÈME BRÛLÉE')).to.deep.eq([accented.slug]);
      expect(await getSlugs('aeroskobing')).to.deep.eq([accented.slug]);
    });

    it('matches supported word forms (stemming)', async () => {
      expect(await getSlugs('wombatting collective')).to.deep.eq([stemmed.slug]);
      expect(await getSlugs('collectives wombatting')).to.deep.eq([stemmed.slug]);
    });

    it('requires all the words, across all the searchable fields', async () => {
      expect(await getSlugs('narwhal kelpforest plain')).to.deep.eq([described.slug]);
      expect(await getSlugs('narwhal unrelatedword')).to.deep.eq([]);
      expect(await getSlugs('habitats')).to.deep.eq([described.slug]); // HTML stripped
      expect(await getSlugs('nbsp')).to.deep.eq([]);
      expect(await getSlugs('axolotlcare')).to.deep.eq([tagged.slug]);
      expect(await getSlugs('pangolinweb.org')).to.deep.eq([website.slug]);
    });

    it('finds exact identifiers', async () => {
      for (const term of [
        String(accented.id),
        `#${accented.id}`,
        accented.publicId,
        idEncode(accented.id, 'account'),
      ]) {
        const slugs = await getSlugs(term);
        expect(slugs, term).to.include(accented.slug);
      }
    });

    it('matches name and slug prefixes from two characters', async () => {
      expect(await getSlugs('wo')).to.include(stemmed.slug);
      expect(await getSlugs('wombatt coll')).to.deep.eq([stemmed.slug]);
      expect(await getSlugs('w')).to.not.include(stemmed.slug);
    });

    it('matches name typos from three characters', async () => {
      expect(await getSlugs('wombatitng')).to.deep.eq([stemmed.slug]);
      expect(await getSlugs('crem brulée aeroskobng')).to.deep.eq([accented.slug]);
    });
  });

  describe('ranking', () => {
    let exactName: Collective, exactSlug: Collective, wordMatch: Collective, prefixMatch: Collective;
    let typoMatches: Collective[];

    before(async () => {
      // Created in an order that differs from the expected ranking
      prefixMatch = await fakeCollective({ name: 'Tarsierology Unlimited', slug: 'tarsierology-unlimited' });
      wordMatch = await fakeCollective({ name: 'Friends of the Tarsier', slug: 'friends-tarsier' });
      exactName = await fakeCollective({ name: 'Tarsier', slug: 'some-tarsier-group' });
      exactSlug = await fakeCollective({ name: 'Other Name', slug: 'tarsier' });
      typoMatches = [
        await fakeCollective({ name: 'Okapimania Club', slug: 'okapi-one' }),
        await fakeCollective({ name: 'Okapimania Club', slug: 'okapi-two' }),
        await fakeCollective({ name: 'Okapimania Club', slug: 'okapi-three' }),
      ];
    });

    it('orders by quality band: exact label, words, prefix', async () => {
      const accounts = await getAccounts('tarsier');
      const slugs = accounts.collection.nodes.map(n => n.slug);
      expect(slugs.slice(0, 2)).to.have.members([exactName.slug, exactSlug.slug]);
      expect(slugs.slice(2)).to.deep.eq([wordMatch.slug, prefixMatch.slug]);

      const scores = accounts.scores.map(s => s.score);
      expect(scores).to.deep.eq([...scores].sort((a, b) => b - a));
      expect(scores[0]).to.be.within(4500, 4999); // Exact label, Account
      expect(accounts.scores.find(s => s.id === idEncode(wordMatch.id, 'account')).score).to.be.within(3500, 3999);
    });

    it('scores prefix and typo matches in their own bands', async () => {
      const prefix = await getAccounts('tarsi');
      expect(prefix.collection.nodes.map(n => n.slug)).to.include(prefixMatch.slug);
      expect(prefix.scores.find(s => s.id === idEncode(prefixMatch.id, 'account')).score).to.be.within(2500, 2999);

      const typo = await getAccounts('okapimnaia');
      expect(typo.collection.totalCount).to.eq(3);
      typo.scores.forEach(s => expect(s.score).to.be.within(1500, 1999));
    });

    it('breaks ties by descending ID, consistently across pages', async () => {
      const all = await getSlugs('okapimnaia');
      expect(all).to.deep.eq([...typoMatches].reverse().map(c => c.slug));
      const pages = [
        ...(await getSlugs('okapimnaia', { limit: 2, offset: 0 })),
        ...(await getSlugs('okapimnaia', { limit: 2, offset: 2 })),
      ];
      expect(pages).to.deep.eq(all);
    });

    it('returns exact totals and an offset-independent maxScore, including on empty later pages', async () => {
      const firstPage = await getAccounts('tarsier', { limit: 1 });
      const lastPage = await getAccounts('tarsier', { limit: 1, offset: 3 });
      const emptyPage = await getAccounts('tarsier', { limit: 1, offset: 100 });
      for (const page of [firstPage, lastPage, emptyPage]) {
        expect(page.collection.totalCount).to.eq(4);
        expect(page.maxScore).to.eq(firstPage.scores[0].score);
      }
      expect(lastPage.scores[0].score).to.be.below(firstPage.maxScore);
      expect(emptyPage.collection.nodes).to.be.empty;
      expect(emptyPage.scores).to.be.empty;
      expect(emptyPage.collection.offset).to.eq(100);
    });
  });

  describe('eligibility and permissions', () => {
    let hostAdmin: User, collectiveAdmin: User, randomUser: User, rootUser: User;
    let host: Collective, collective: Collective, project: Collective, withLegalName: Collective;

    before(async () => {
      hostAdmin = await fakeUser();
      collectiveAdmin = await fakeUser();
      randomUser = await fakeUser();
      rootUser = await fakeUser({ data: { isRoot: true } });
      const platform = await fakeOrganization({ id: PlatformConstants.PlatformCollectiveId, name: 'Platform' });
      await platform.addUserWithRole(rootUser, 'ADMIN');

      host = await fakeActiveHost({ name: 'Capybara Host', slug: 'capybara-host', admin: hostAdmin });
      collective = await fakeCollective({
        name: 'Capybara Collective',
        slug: 'capybara-collective',
        HostCollectiveId: host.id,
        admin: collectiveAdmin,
      });
      project = await fakeProject({
        name: 'Capybara Project',
        slug: 'capybara-project',
        ParentCollectiveId: collective.id,
      });
      withLegalName = await fakeCollective({
        name: 'Capybara Legal',
        slug: 'capybara-legal',
        legalName: 'Secretlegalword Incorporated',
        HostCollectiveId: host.id,
      });

      // Never searchable, even for root
      await fakeCollective({ name: 'Capybara Quagga Private', slug: 'quagga-private', isPrivate: true });
      await fakeCollective({ name: 'Capybara Quagga Hidden', slug: 'quagga-hidden', data: { hideFromSearch: true } });
      await fakeCollective({ name: 'Capybara Quagga Guest', slug: 'quagga-guest', data: { isGuest: true } });
      await fakeCollective({ name: 'Capybara Quagga Incognito', slug: 'quagga-incognito', isIncognito: true });
      await fakeCollective({ name: 'Capybara Quagga Archived', slug: 'quagga-archived', deactivatedAt: new Date() });
      await (await fakeCollective({ name: 'Capybara Quagga Deleted', slug: 'quagga-deleted' })).destroy();
    });

    it('only returns eligible accounts, even for root', async () => {
      const expected = [host.slug, collective.slug, project.slug, withLegalName.slug];
      expect(await getSlugs('capybara')).to.have.members(expected);
      expect(await getSlugs('capybara', {}, rootUser)).to.have.members(expected);
      for (const term of ['quagga', 'quagga-private', 'quagga-guest', 'capybara quagga hidden']) {
        expect(await getSlugs(term, {}, rootUser), term).to.deep.eq([]);
      }
    });

    it('only lets permitted users search the legal name', async () => {
      const expectations: Array<[string, User | null, boolean]> = [
        ['unauthenticated', null, false],
        ['random user', randomUser, false],
        ['collective admin of another account', collectiveAdmin, false],
        ['host admin', hostAdmin, true],
        ['root', rootUser, true],
      ];

      for (const [label, user, canSearch] of expectations) {
        const accounts = await getAccounts('secretlegalword', {}, user);
        expect(accounts.collection.totalCount, label).to.eq(canSearch ? 1 : 0);
        // Restricted-only words never affect other results
        const combined = await getAccounts('capybara secretlegalword', {}, user);
        expect(combined.collection.totalCount, label).to.eq(canSearch ? 1 : 0);
      }

      // The account's own admin
      const legalAdmin = await fakeUser();
      await withLegalName.addUserWithRole(legalAdmin, 'ADMIN');
      expect((await getAccounts('secretlegalword', {}, legalAdmin)).collection.totalCount).to.eq(1);
    });

    it('does not let OAuth tokens without the account scope search the legal name', async () => {
      const query = (scope: OAuthScopes[]) =>
        fakeUserToken({ scope, UserId: hostAdmin.id }).then(token =>
          oAuthGraphqlQueryV2(accountsSearchQuery, { searchTerm: 'secretlegalword', backend: 'POSTGRES' }, token),
        );

      const withoutScope = await query([OAuthScopes.expenses]);
      expect(withoutScope.errors).to.not.exist;
      expect(withoutScope.data.search.results.accounts.collection.totalCount).to.eq(0);
      const withScope = await query([OAuthScopes.account]);
      expect(withScope.data.search.results.accounts.collection.totalCount).to.eq(1);
    });

    it('scopes accounts to the account itself and its children', async () => {
      expect(await getSlugs('capybara', { account: { slug: collective.slug } })).to.have.members([
        collective.slug,
        project.slug,
      ]);
    });

    it('scopes accounts to the hosted accounts', async () => {
      // The project is hosted by its parent's host
      expect(await getSlugs('capybara', { host: { slug: host.slug } })).to.have.members([
        host.slug,
        collective.slug,
        project.slug,
        withLegalName.slug,
      ]);
    });

    it('intersects account and host scopes', async () => {
      expect(
        await getSlugs('capybara', { account: { slug: collective.slug }, host: { slug: host.slug } }),
      ).to.have.members([collective.slug, project.slug]);
      expect(await getSlugs('capybara', { account: { slug: host.slug }, host: { slug: host.slug } })).to.deep.eq([
        host.slug,
      ]);
      const otherHost = await fakeActiveHost({ name: 'Another Host Zzz', slug: 'another-host-zzz' });
      expect(await getSlugs('capybara', { account: { slug: collective.slug }, host: { slug: otherHost.slug } })).to.be
        .empty;
    });

    it('applies the type, isHost and tags filters', async () => {
      await collective.update({ tags: ['rodentlovers'] });
      expect(await getSlugs('capybara', { type: 'ORGANIZATION' })).to.deep.eq([host.slug]);
      expect(await getSlugs('capybara', { isHost: true })).to.deep.eq([host.slug]);
      expect(await getSlugs('capybara', { type: 'PROJECT' })).to.deep.eq([project.slug]);
      expect(await getSlugs('capybara', { tags: ['rodentlovers', 'other'] })).to.deep.eq([collective.slug]);
    });

    it('reflects live changes', async () => {
      await project.update({ name: 'Renamed Hippopotamus' });
      expect(await getSlugs('hippopotamus')).to.deep.eq([project.slug]);
      await project.update({ isPrivate: true });
      expect(await getSlugs('hippopotamus', {}, rootUser)).to.deep.eq([]);
    });
  });

  describe('execution budget', () => {
    it('cancels the SQL work when the budget is exceeded, shows a visible error, and resets the connection', async () => {
      await fakeCollective({ name: 'Budgeted Ibex', slug: 'budgeted-ibex' });

      // Hold a lock that the search has to wait for, to simulate a slow query
      const lockingTransaction = await sequelize.transaction();
      try {
        await sequelize.query('LOCK TABLE "Collectives" IN ACCESS EXCLUSIVE MODE', {
          transaction: lockingTransaction,
        });

        const start = Date.now();
        const result = await searchAccounts('ibex', { timeout: 300 });
        expect(Date.now() - start).to.be.below(5000);
        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.eq('SearchTooBroad');
        expect(result.errors[0].message).to.match(/Narrow your search/);

        // The canceled statement does not hold the lock queue anymore
        const waiting = await sequelize.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted AND relation = '"Collectives"'::regclass`,
          { type: QueryTypes.SELECT, transaction: lockingTransaction },
        );
        expect(waiting).to.deep.eq([{ count: 0 }]);
      } finally {
        await lockingTransaction.rollback();
      }

      // Pooled connections are back to their default settings
      const settings = await Promise.all(
        times(10, () =>
          sequelize.query<{ timeout: string; mem: string }>(
            `SELECT current_setting('statement_timeout') AS timeout, current_setting('work_mem') AS mem`,
            { type: QueryTypes.SELECT },
          ),
        ),
      );
      const defaults = settings[0][0];
      expect(defaults.timeout).to.eq('0');
      settings.forEach(([row]) => expect(row).to.deep.eq(defaults));

      expect(await getSlugs('ibex')).to.deep.eq(['budgeted-ibex']);
    });
  });
});
