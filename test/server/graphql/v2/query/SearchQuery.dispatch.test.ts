/**
 * Provider-independent search orchestration (opencollective#8936).
 *
 * These tests go through the GraphQL V2 `search` query with real PostgreSQL fixtures. OpenSearch is an external
 * system: it is replaced by an in-memory fake client that honors the parts of the OpenSearch contract used by
 * the orchestration (index selection, `from`/`size`, top hits aggregation and `type` term filters), so these
 * tests run without a cluster.
 */

import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import sinon from 'sinon';

import { CollectiveType } from '../../../../../server/constants/collectives';
import * as OpenSearchClientSingletonLib from '../../../../../server/lib/open-search/client';
import { formatIndexNameForOpenSearch } from '../../../../../server/lib/open-search/common';
import { OpenSearchIndexName } from '../../../../../server/lib/open-search/constants';
import { Collective } from '../../../../../server/models';
import { fakeCollective, fakeOrganization, fakeTier, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetCaches, resetTestDB } from '../../../../utils';

type FakeDocument = { id: number; type?: string };

/**
 * Collects every `{ term: { [field]: value } }` filter in an OpenSearch query.
 */
const collectTermFilters = (node: unknown, field: string, values: unknown[] = []): unknown[] => {
  if (Array.isArray(node)) {
    node.forEach(child => collectTermFilters(child, field, values));
  } else if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) {
      if (key === 'term' && child && typeof child === 'object' && field in child) {
        values.push(child[field]);
      } else {
        collectTermFilters(child, field, values);
      }
    }
  }

  return values;
};

/**
 * A fake OpenSearch client: every document of a requested index matches, ranked in insertion order with
 * decreasing scores.
 */
const makeFakeOpenSearchClient = (documentsByIndex: Partial<Record<OpenSearchIndexName, FakeDocument[]>>) => {
  const getIndexName = (formattedName: string) =>
    Object.values(OpenSearchIndexName).find(name => formatIndexNameForOpenSearch(name) === formattedName);

  const getMatches = (index: OpenSearchIndexName, query: unknown) => {
    const typeFilters = collectTermFilters(query, 'type');
    return (documentsByIndex[index] || [])
      .filter(doc => typeFilters.every(type => doc.type === type))
      .map((doc, rank) => ({
        _index: formatIndexNameForOpenSearch(index),
        _id: String(doc.id),
        _score: 100 - rank,
        _source: { id: doc.id },
        highlight: {},
      }));
  };

  return {
    search: sinon.spy(async ({ index, body }) => {
      const indexes = (index as string).split(',').map(getIndexName);
      if (body.aggs) {
        const { size, from } = body.aggs.by_index.aggs.top_hits_by_index.top_hits;
        const buckets = indexes.map(indexName => {
          const matches = getMatches(indexName, body.query);
          return {
            key: formatIndexNameForOpenSearch(indexName),
            // eslint-disable-next-line camelcase
            doc_count: matches.length,
            // eslint-disable-next-line camelcase
            top_hits_by_index: {
              // eslint-disable-next-line camelcase
              hits: { max_score: matches[0]?._score ?? null, hits: matches.slice(from, from + size) },
            },
          };
        });
        // eslint-disable-next-line camelcase
        return { body: { aggregations: { by_index: { buckets: buckets.filter(b => b.doc_count > 0) } } } };
      } else {
        const matches = indexes.flatMap(indexName => getMatches(indexName, body.query));
        return {
          body: {
            hits: {
              total: { value: matches.length, relation: 'eq' },
              // eslint-disable-next-line camelcase
              max_score: matches[0]?._score ?? null,
              hits: matches.slice(body.from, body.from + body.size),
            },
          },
        };
      }
    }),
  };
};

describe('server/graphql/v2/query/SearchQuery (provider-independent dispatch)', () => {
  let sandbox: sinon.SinonSandbox;
  let fakeClient: ReturnType<typeof makeFakeOpenSearchClient>;
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
    fakeClient = makeFakeOpenSearchClient({
      [OpenSearchIndexName.COLLECTIVES]: [
        ...collectives.map(c => ({ id: c.id, type: CollectiveType.COLLECTIVE })),
        ...organizations.map(c => ({ id: c.id, type: CollectiveType.ORGANIZATION })),
      ],
      [OpenSearchIndexName.TIERS]: tierIds.map(id => ({ id })),
    });
    sandbox.stub(OpenSearchClientSingletonLib, 'getOpenSearchClient').returns(fakeClient as never);
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
      expect(fakeClient.search.callCount).to.eq(1);
    });
  });

  describe('provider availability and access', () => {
    it('reports when OpenSearch is not configured', async () => {
      sandbox.stub(OpenSearchClientSingletonLib, 'isOpenSearchConfigured').returns(false);
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

      const previewUser = await fakeUser(undefined, { settings: { earlyAccess: { SEARCH_COMMAND: true } } });
      const allowed = await graphqlQueryV2(searchAccountsQuery, {}, previewUser);
      expect(allowed.errors).to.be.undefined;
      expect(allowed.data.search.results.accounts.collection.totalCount).to.eq(8);
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
