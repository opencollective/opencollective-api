/**
 * PostgreSQL search provider: all eight entities together (opencollective#8944).
 *
 * One fixture "world" where the same word appears in every entity, searched in single GraphQL requests the way the
 * frontend does (every entity at once, aliases, mixed providers), to check that entities, pages, permissions and errors
 * stay isolated from each other. Entity-specific behavior is tested in the other `SearchQuery.postgres.*` files.
 */

import { expect } from 'chai';
import sinon from 'sinon';

import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import PlatformConstants from '../../../../../server/constants/platform';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import * as OpenSearchClientLib from '../../../../../server/lib/open-search/client';
import { formatIndexNameForOpenSearch } from '../../../../../server/lib/open-search/common';
import { OpenSearchIndexName } from '../../../../../server/lib/open-search/constants';
import { SearchEntity } from '../../../../../server/lib/search/types';
import { Collective, sequelize, User } from '../../../../../server/models';
import { CommentType } from '../../../../../server/models/Comment';
import {
  fakeActiveHost,
  fakeCollective,
  fakeComment,
  fakeExpense,
  fakeHostApplication,
  fakeOrder,
  fakeOrganization,
  fakeTier,
  fakeTransaction,
  fakeUpdate,
  fakeUser,
  fakeUserToken,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetTestDB } from '../../../../utils';

const ENTITIES = Object.values(SearchEntity);

const ENTITY_FIELDS = 'maxScore scores { score } collection { totalCount offset nodes { id } }';

/** Every entity once, as the frontend requests them */
// Built dynamically (one field per entity), so not a `gql` literal
const allEntitiesQuery = `
  query PostgresAllEntitiesSearch($searchTerm: String!, $limit: Int, $timeout: Int, $host: AccountReferenceInput) {
    search(searchTerm: $searchTerm, backend: POSTGRES, timeout: $timeout, host: $host) {
      results {
        ${ENTITIES.map(entity => `${entity}(limit: $limit) { ${ENTITY_FIELDS} }`).join('\n')}
      }
    }
  }
`;

/**
 * Some entities twice in the same request: the first page, and a later page beyond the last result (a request
 * accepts up to `limits.search.concurrentRequests` entity fields)
 */
const getPagesQuery = (entities: SearchEntity[]) => `
  query PostgresSearchPages($searchTerm: String!) {
    search(searchTerm: $searchTerm, backend: POSTGRES) {
      results {
        ${entities.map(entity => `${entity}(limit: 1) { ${ENTITY_FIELDS} }\n${entity}LaterPage: ${entity}(limit: 1, offset: 40) { ${ENTITY_FIELDS} }`).join('\n')}
      }
    }
  }
`;

type EntityResult = {
  maxScore: number;
  scores: Array<{ score: number }>;
  collection: { totalCount: number; offset: number; nodes: Array<{ id: string }> };
};

type Totals = Record<SearchEntity, number>;

const searchAll = async (
  remoteUser: User | null,
  variables: { searchTerm?: string; timeout?: number; host?: { slug: string } } = {},
) => graphqlQueryV2(allEntitiesQuery, { searchTerm: 'okapi', limit: 10, ...variables }, remoteUser);

const getTotals = (results: Record<string, EntityResult>): Totals =>
  Object.fromEntries(ENTITIES.map(entity => [entity, results[entity].collection.totalCount])) as Totals;

describe('server/graphql/v2/query/SearchQuery (PostgreSQL, all entities)', () => {
  let sandbox: sinon.SinonSandbox;
  let rootUser: User, hostAdmin: User, collectiveAdmin: User, randomUser: User;
  let host: Collective, collective: Collective;

  before(async () => {
    await resetTestDB();
    rootUser = await fakeUser({ data: { isRoot: true } });
    const platform = await fakeOrganization({ id: PlatformConstants.PlatformCollectiveId, name: 'Platform' });
    await platform.addUserWithRole(rootUser, 'ADMIN');
    hostAdmin = await fakeUser();
    collectiveAdmin = await fakeUser();
    randomUser = await fakeUser();
    host = await fakeActiveHost({ name: 'Savanna Host', slug: 'savanna-host', admin: hostAdmin });

    // One row (or a public and a restricted row) per entity, all matching "okapi"
    collective = await fakeCollective({
      name: 'Okapi Reserve',
      slug: 'okapi-reserve',
      HostCollectiveId: host.id,
      isActive: true,
      admin: collectiveAdmin,
    });
    await fakeTier({ CollectiveId: collective.id, name: 'Okapi Backer', slug: 'okapi-backer' });
    await fakeUpdate({ CollectiveId: collective.id, title: 'Okapi news', publishedAt: new Date(), isPrivate: false });
    await fakeUpdate({
      CollectiveId: collective.id,
      title: 'Okapi secret news',
      publishedAt: new Date(),
      isPrivate: true,
    });
    const expense = await fakeExpense({
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      description: 'Okapi travel',
    });
    await fakeOrder({ CollectiveId: collective.id, description: 'Okapi donation' });
    await fakeTransaction(
      {
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        kind: TransactionKind.ADDED_FUNDS,
        description: 'Okapi grant',
        amount: 1000,
      },
      { createDoubleEntry: true },
    );
    await fakeComment({ CollectiveId: collective.id, ExpenseId: expense.id, html: '<p>Okapi receipt</p>' });
    await fakeComment({
      CollectiveId: collective.id,
      ExpenseId: expense.id,
      html: '<p>Okapi note for the host</p>',
      type: CommentType.PRIVATE_NOTE,
    });
    await fakeHostApplication({ CollectiveId: collective.id, HostCollectiveId: host.id, message: 'Okapi please' });

    // A private account with the same word everywhere: never searchable, even for root
    const privateCollective = await fakeCollective({
      name: 'Okapi Hidden Reserve',
      HostCollectiveId: host.id,
      isActive: true,
      isPrivate: true,
    });
    await fakeTier({ CollectiveId: privateCollective.id, name: 'Okapi Hidden Backer' });
    await fakeUpdate({ CollectiveId: privateCollective.id, title: 'Okapi hidden news', publishedAt: new Date() });
    const privateExpense = await fakeExpense({
      CollectiveId: privateCollective.id,
      HostCollectiveId: host.id,
      description: 'Okapi hidden travel',
    });
    await fakeOrder({ CollectiveId: privateCollective.id, description: 'Okapi hidden donation' });
    await fakeTransaction(
      {
        CollectiveId: privateCollective.id,
        HostCollectiveId: host.id,
        kind: TransactionKind.ADDED_FUNDS,
        description: 'Okapi hidden grant',
        amount: 1000,
      },
      { createDoubleEntry: true },
    );
    await fakeComment({ CollectiveId: privateCollective.id, ExpenseId: privateExpense.id, html: 'Okapi hidden' });
    await fakeHostApplication({
      CollectiveId: privateCollective.id,
      HostCollectiveId: host.id,
      message: 'Okapi hidden',
    });
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(OpenSearchClientLib, 'isOpenSearchConfigured').returns(false);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('applies the permissions of each entity in the same request, never showing private accounts', async () => {
    // Public rows: 1 per entity (2 for the double-entry transaction). Restricted rows: the private Update, the
    // Comments (the private note for host administrators only) and the host application.
    const publicTotals: Totals = {
      accounts: 1,
      comments: 0,
      expenses: 1,
      hostApplications: 0,
      orders: 1,
      tiers: 1,
      transactions: 2,
      updates: 1,
    };
    const expectations: Array<[string, User | null, Totals]> = [
      ['unauthenticated', null, publicTotals],
      ['random user', randomUser, publicTotals],
      ['collective admin', collectiveAdmin, { ...publicTotals, comments: 1, hostApplications: 1, updates: 2 }],
      ['host admin', hostAdmin, { ...publicTotals, comments: 2, hostApplications: 1, updates: 2 }],
      ['root', rootUser, { ...publicTotals, comments: 2, hostApplications: 1, updates: 2 }],
    ];

    for (const [label, user, totals] of expectations) {
      const result = await searchAll(user);
      expect(result.errors, `${label}: ${JSON.stringify(result.errors)}`).to.not.exist;
      expect(getTotals(result.data.search.results), label).to.deep.eq(totals);
      for (const entity of ENTITIES) {
        const { collection, scores, maxScore } = result.data.search.results[entity];
        expect(collection.nodes, `${label} ${entity}`).to.have.length(totals[entity]);
        expect(scores, `${label} ${entity}`).to.have.length(totals[entity]);
        expect(maxScore, `${label} ${entity}`).to.eq(totals[entity] ? Math.max(...scores.map(s => s.score)) : 0);
      }
    }
  });

  it('applies OAuth scopes per entity in the same request', async () => {
    // A token with the `account` scope only: other entities only show public rows, and Comments on Expenses need the
    // `expenses` scope even for their host administrators
    const token = await fakeUserToken({ scope: [OAuthScopes.account], UserId: hostAdmin.id });
    const result = await oAuthGraphqlQueryV2(allEntitiesQuery, { searchTerm: 'okapi', limit: 10 }, token);
    expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
    expect(getTotals(result.data.search.results)).to.deep.eq({
      accounts: 1,
      comments: 0,
      expenses: 1,
      hostApplications: 0,
      orders: 1,
      tiers: 1,
      transactions: 2,
      updates: 1,
    });
  });

  it('returns independent pages with the same exact totals and offset-independent maxScore for every entity', async () => {
    for (const entities of [ENTITIES.slice(0, 4), ENTITIES.slice(4)]) {
      const result = await graphqlQueryV2(getPagesQuery(entities), { searchTerm: 'okapi' }, rootUser);
      expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
      const results = result.data.search.results;
      for (const entity of entities) {
        const page = results[entity] as EntityResult;
        const laterPage = results[`${entity}LaterPage`] as EntityResult;
        expect(page.collection.totalCount, entity).to.be.greaterThan(0);
        expect(page.collection.nodes, entity).to.have.length(1);
        expect(laterPage.collection.offset, entity).to.eq(40);
        expect(laterPage.collection.nodes, entity).to.deep.eq([]);
        expect(laterPage.scores, entity).to.deep.eq([]);
        expect(laterPage.collection.totalCount, entity).to.eq(page.collection.totalCount);
        expect(laterPage.maxScore, entity).to.eq(page.maxScore);
        expect(page.maxScore, entity).to.eq(page.scores[0].score);
      }
    }
  });

  it('intersects the host scope with every entity', async () => {
    const otherHost = await fakeActiveHost({ name: 'Tundra Host', slug: 'tundra-host' });
    const scoped = await searchAll(rootUser, { host: { slug: host.slug } });
    expect(scoped.errors, JSON.stringify(scoped.errors)).to.not.exist;
    // Every row of the world is hosted by `host`, except the DEBIT side of the transaction (the contributor's ledger,
    // whose own host attribution is empty)
    const unscoped = await searchAll(rootUser);
    const unscopedTotals = getTotals(unscoped.data.search.results);
    expect(getTotals(scoped.data.search.results)).to.deep.eq({
      ...unscopedTotals,
      transactions: unscopedTotals.transactions - 1,
    });

    const other = await searchAll(rootUser, { host: { slug: otherHost.slug } });
    expect(other.errors, JSON.stringify(other.errors)).to.not.exist;
    expect(Object.values(getTotals(other.data.search.results))).to.deep.eq(ENTITIES.map(() => 0));
  });

  it('can mix providers in the same request, each alias with its own results', async () => {
    sandbox.restore();
    sandbox = sinon.createSandbox();
    sandbox.stub(OpenSearchClientLib, 'isOpenSearchConfigured').returns(true);
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
                _id: String(host.id),
                _score: 42,
                _source: { id: host.id },
              },
            ],
          },
        },
      }),
    } as unknown as ReturnType<typeof OpenSearchClientLib.getOpenSearchClient>);

    const result = await graphqlQueryV2(
      `
        query MixedProvidersAllEntities($searchTerm: String!) {
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
              ${ENTITIES.map(entity => `${entity}(limit: 10) { collection { totalCount } }`).join('\n')}
            }
          }
        }
      `,
      { searchTerm: 'okapi' },
      rootUser,
    );

    expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
    expect(result.data.os.results.accounts.maxScore).to.eq(42);
    expect(result.data.os.results.accounts.collection.nodes.map(n => n.slug)).to.deep.eq([host.slug]);
    const pgTotals = Object.fromEntries(
      ENTITIES.map(entity => [entity, result.data.pg.results[entity].collection.totalCount]),
    );
    expect(pgTotals).to.deep.eq({
      accounts: 1,
      comments: 2,
      expenses: 1,
      hostApplications: 1,
      orders: 1,
      tiers: 1,
      transactions: 2,
      updates: 2,
    });
  });

  it('reports a visible error on the entity that could not complete, without affecting the others', async () => {
    // A long write lock on "Tiers" makes the Tiers search wait until the budget is exhausted
    const lockTransaction = await sequelize.transaction();
    try {
      await sequelize.query(`LOCK TABLE "Tiers" IN ACCESS EXCLUSIVE MODE`, { transaction: lockTransaction });
      const result = await searchAll(rootUser, { timeout: 1500 });
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].path).to.deep.eq(['search', 'results', 'tiers']);
      for (const error of result.errors) {
        expect(error.extensions.code).to.eq('SearchTooBroad');
        expect(error.message).to.include('Narrow your search');
      }
      expect(result.data.search.results.tiers).to.be.null;
      for (const entity of ENTITIES.filter(entity => entity !== SearchEntity.TIERS)) {
        expect(result.data.search.results[entity].collection.totalCount, entity).to.be.greaterThan(0);
      }
    } finally {
      await lockTransaction.rollback();
    }
  });
});
