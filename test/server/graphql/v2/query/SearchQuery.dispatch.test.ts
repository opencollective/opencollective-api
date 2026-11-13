/**
 * Provider-independent search orchestration (opencollective#8936).
 *
 * These tests go through the GraphQL V2 `search` query with real PostgreSQL fixtures. The provider's `search` is
 * replaced by an in-memory fake that honors the parts of the provider contract used by the orchestration (one
 * result per entity request, `limit`/`offset` and the accounts `type` filter), so that results are deterministic.
 */

import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import sinon from 'sinon';

import { CollectiveType } from '../../../../../server/constants/collectives';
import PlatformConstants from '../../../../../server/constants/platform';
import { PostgresProvider } from '../../../../../server/lib/search/providers/postgres';
import { SearchEntity, SearchEntityRequest, SearchEntityResult } from '../../../../../server/lib/search/types';
import { Collective } from '../../../../../server/models';
import { fakeCollective, fakeOrganization, fakeTier, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetCaches, resetTestDB } from '../../../../utils';

type FakeDocument = { id: number; type?: string };

/**
 * A fake provider search: every document of a requested entity matches, ranked in insertion order with
 * decreasing scores.
 */
const makeFakeProviderSearch = (documentsByEntity: Partial<Record<SearchEntity, FakeDocument[]>>) =>
  sinon.spy(async (_request, entityRequests: SearchEntityRequest[]): Promise<SearchEntityResult[]> =>
    entityRequests.map(({ entity, params, limit, offset }) => {
      const type = (params as { type?: string })?.type;
      const matches = (documentsByEntity[entity] || [])
        .filter(doc => !type || doc.type === type)
        .map((doc, rank) => ({ id: doc.id, score: 100 - rank, highlight: {} }));
      return {
        totalCount: matches.length,
        maxScore: matches[0]?.score ?? 0,
        hits: matches.slice(offset, offset + limit),
      };
    }),
  );

describe('server/graphql/v2/query/SearchQuery (provider-independent dispatch)', () => {
  let sandbox: sinon.SinonSandbox;
  let fakeSearch: ReturnType<typeof makeFakeProviderSearch>;
  let collectives: Collective[];
  let organizations: Collective[];
  let tierIds: number[];

  before(async () => {
    await resetTestDB();
    await resetCaches(); // Search rate-limit counters are keyed by user ID, which the DB reset reuses
    collectives = [];
    for (let i = 0; i < 5; i++) {
      collectives.push(await fakeCollective({ name: `Dispatch Collective ${i}` }));
    }
    organizations = [];
    for (let i = 0; i < 3; i++) {
      organizations.push(await fakeOrganization({ name: `Dispatch Organization ${i}` }));
    }
    tierIds = [];
    for (let i = 0; i < 4; i++) {
      tierIds.push((await fakeTier({ CollectiveId: collectives[0].id, name: `Dispatch Tier ${i}` })).id);
    }
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    fakeSearch = makeFakeProviderSearch({
      [SearchEntity.ACCOUNTS]: [
        ...collectives.map(c => ({ id: c.id, type: CollectiveType.COLLECTIVE })),
        ...organizations.map(c => ({ id: c.id, type: CollectiveType.ORGANIZATION })),
      ],
      [SearchEntity.TIERS]: tierIds.map(id => ({ id })),
    });
    sandbox.stub(PostgresProvider, 'search').callsFake(fakeSearch);
  });

  afterEach(() => {
    sandbox.restore();
  });

  const searchAccountsQuery = gql`
    query {
      search(searchTerm: "dispatch") {
        results {
          accounts {
            collection {
              totalCount
            }
          }
        }
      }
    }
  `;

  const getNames = (results, alias: string) => results[alias].collection.nodes.map(node => node.name);
  const allAccountNames = () => [...collectives, ...organizations].map(c => c.name);

  describe('aliases inside a single search', () => {
    it('returns its own page for each aliased entity field', async () => {
      const result = await graphqlQueryV2(
        gql`
          query {
            search(searchTerm: "dispatch") {
              results {
                firstPage: accounts(offset: 0, limit: 2) {
                  collection {
                    totalCount
                    offset
                    limit
                    nodes {
                      name
                    }
                  }
                }
                secondPage: accounts(offset: 2, limit: 2) {
                  collection {
                    totalCount
                    offset
                    limit
                    nodes {
                      name
                    }
                  }
                }
              }
            }
          }
        `,
        {},
        await fakeUser(),
      );

      expect(result.errors).to.be.undefined;
      const results = result.data.search.results;
      expect(results.firstPage.collection.totalCount).to.eq(8);
      expect(results.secondPage.collection.totalCount).to.eq(8);
      expect(results.secondPage.collection.offset).to.eq(2);
      expect(getNames(results, 'firstPage')).to.deep.eq(allAccountNames().slice(0, 2));
      expect(getNames(results, 'secondPage')).to.deep.eq(allAccountNames().slice(2, 4));
    });

    [false, true].forEach(useTopHits => {
      it(`uses each entity's own limit (useTopHits=${useTopHits})`, async () => {
        const result = await graphqlQueryV2(
          gql`
            query ($useTopHits: Boolean!) {
              search(searchTerm: "dispatch", useTopHits: $useTopHits, defaultLimit: 2) {
                results {
                  accounts(limit: 1) {
                    collection {
                      totalCount
                      limit
                      nodes {
                        name
                      }
                    }
                  }
                  tiers(limit: 3) {
                    collection {
                      totalCount
                      limit
                      nodes {
                        name
                      }
                    }
                  }
                  defaultLimitTiers: tiers {
                    collection {
                      limit
                      nodes {
                        name
                      }
                    }
                  }
                }
              }
            }
          `,
          { useTopHits },
          await fakeUser(),
        );

        expect(result.errors).to.be.undefined;
        const results = result.data.search.results;
        expect(results.accounts.collection.totalCount).to.eq(8);
        expect(getNames(results, 'accounts')).to.deep.eq(allAccountNames().slice(0, 1));
        expect(results.tiers.collection.totalCount).to.eq(4);
        expect(getNames(results, 'tiers')).to.deep.eq(['Dispatch Tier 0', 'Dispatch Tier 1', 'Dispatch Tier 2']);
        expect(results.defaultLimitTiers.collection.limit).to.eq(2);
        expect(getNames(results, 'defaultLimitTiers')).to.deep.eq(['Dispatch Tier 0', 'Dispatch Tier 1']);
      });

      it(`applies each alias's own filters (useTopHits=${useTopHits})`, async () => {
        const result = await graphqlQueryV2(
          gql`
            query ($useTopHits: Boolean!) {
              search(searchTerm: "dispatch", useTopHits: $useTopHits) {
                results {
                  organizations: accounts(type: ORGANIZATION, limit: 2) {
                    collection {
                      totalCount
                      nodes {
                        name
                      }
                    }
                  }
                  collectives: accounts(type: COLLECTIVE, limit: 10) {
                    collection {
                      totalCount
                      nodes {
                        name
                      }
                    }
                  }
                }
              }
            }
          `,
          { useTopHits },
          await fakeUser(),
        );

        expect(result.errors).to.be.undefined;
        const results = result.data.search.results;
        expect(results.organizations.collection.totalCount).to.eq(3);
        expect(getNames(results, 'organizations')).to.deep.eq(organizations.slice(0, 2).map(c => c.name));
        expect(results.collectives.collection.totalCount).to.eq(5);
        expect(getNames(results, 'collectives')).to.deep.eq(collectives.map(c => c.name));
      });
    });
  });

  describe('repeated searches', () => {
    it('does not share pagination between aliased searches', async () => {
      const result = await graphqlQueryV2(
        gql`
          query {
            first: search(searchTerm: "dispatch", defaultLimit: 1) {
              results {
                accounts {
                  collection {
                    nodes {
                      name
                    }
                  }
                }
              }
            }
            second: search(searchTerm: "dispatch", defaultLimit: 3) {
              results {
                accounts(offset: 3) {
                  collection {
                    nodes {
                      name
                    }
                  }
                }
              }
            }
          }
        `,
        {},
        await fakeUser(),
      );

      expect(result.errors).to.be.undefined;
      expect(getNames(result.data.first.results, 'accounts')).to.deep.eq(allAccountNames().slice(0, 1));
      expect(getNames(result.data.second.results, 'accounts')).to.deep.eq(allAccountNames().slice(3, 6));
    });

    it('runs identical entity searches only once', async () => {
      const result = await graphqlQueryV2(
        gql`
          query {
            first: search(searchTerm: "dispatch") {
              results {
                accounts(limit: 2) {
                  collection {
                    totalCount
                  }
                }
              }
            }
            second: search(searchTerm: "dispatch") {
              results {
                accounts(limit: 2) {
                  collection {
                    totalCount
                  }
                }
              }
            }
          }
        `,
        {},
        await fakeUser(),
      );

      expect(result.errors).to.be.undefined;
      expect(result.data.first.results.accounts.collection.totalCount).to.eq(8);
      expect(result.data.second.results.accounts.collection.totalCount).to.eq(8);
      expect(fakeSearch.callCount).to.eq(1);
    });
  });

  describe('provider availability and access', () => {
    it('reports when the search is turned off', async () => {
      sandbox.stub(config.search.postgres, 'enabled').value('false');
      const result = await graphqlQueryV2(searchAccountsQuery, {}, await fakeUser());
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('The search is temporarily unavailable');
    });

    it('is restricted to preview users in production', async () => {
      sandbox.stub(config, 'env').value('production');
      const user = await fakeUser();
      const forbidden = await graphqlQueryV2(searchAccountsQuery, {}, user);
      expect(forbidden.errors).to.exist;
      expect(forbidden.errors[0].extensions.code).to.eq('Forbidden');

      // Enabling the preview is not enough: the user must also be part of an allowed account
      const previewUser = await fakeUser(undefined, { settings: { earlyAccess: { SEARCH_COMMAND: true } } });
      const notAllowed = await graphqlQueryV2(searchAccountsQuery, {}, previewUser);
      expect(notAllowed.errors).to.exist;
      expect(notAllowed.errors[0].extensions.code).to.eq('Forbidden');

      const firstPartyHost = await fakeOrganization({ id: PlatformConstants.FirstPartyHostCollectiveIds[0] });
      await firstPartyHost.addUserWithRole(previewUser, 'MEMBER');
      const asMember = await graphqlQueryV2(searchAccountsQuery, {}, previewUser);
      expect(asMember.errors).to.exist;
      expect(asMember.errors[0].extensions.code).to.eq('Forbidden');

      await firstPartyHost.addUserWithRole(previewUser, 'ADMIN');
      const allowed = await graphqlQueryV2(searchAccountsQuery, {}, previewUser);
      expect(allowed.errors).to.be.undefined;
      expect(allowed.data.search.results.accounts.collection.totalCount).to.eq(8);
    });

    it('is available to platform accounts admins in production', async () => {
      sandbox.stub(config, 'env').value('production');
      const user = await fakeUser(undefined, { settings: { earlyAccess: { SEARCH_COMMAND: true } } });
      const platformAccount = await fakeOrganization({ id: PlatformConstants.OficoCollectiveId });
      await platformAccount.addUserWithRole(user, 'ADMIN');
      const result = await graphqlQueryV2(searchAccountsQuery, {}, user);
      expect(result.errors).to.be.undefined;
    });

    it('requires the preview to be enabled in production, even for allowed users', async () => {
      sandbox.stub(config, 'env').value('production');
      const user = await fakeUser();
      const firstPartyHost = await fakeOrganization({ id: PlatformConstants.FirstPartyHostCollectiveIds[1] });
      await firstPartyHost.addUserWithRole(user, 'ADMIN');
      const result = await graphqlQueryV2(searchAccountsQuery, {}, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.eq('Forbidden');
    });

    it('is rate limited per user', async () => {
      sandbox.stub(config.limits.search.global, 'perMinutePerUser').value(1);
      const user = await fakeUser();
      const first = await graphqlQueryV2(searchAccountsQuery, {}, user);
      expect(first.errors).to.be.undefined;
      const second = await graphqlQueryV2(searchAccountsQuery, {}, user);
      expect(second.errors).to.exist;
      expect(second.errors[0].extensions.code).to.eq('RateLimitExceeded');
    });
  });
});
