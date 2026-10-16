/**
 * PostgreSQL search provider: Expenses and their items (opencollective#8939).
 *
 * Goes through the GraphQL V2 `search` query with real PostgreSQL fixtures, without an OpenSearch cluster.
 * Fixtures use made-up words so that tests don't match each other's expenses.
 */

import { expect } from 'chai';
import gql from 'fake-tag';
import sinon from 'sinon';

import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import PlatformConstants from '../../../../../server/constants/platform';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import * as OpenSearchClientLib from '../../../../../server/lib/open-search/client';
import { Collective, Expense, ExpenseItem, User } from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeExpenseItem,
  fakeOrganization,
  fakeProject,
  fakeUser,
  fakeUserToken,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetCaches, resetTestDB } from '../../../../utils';

const expensesSearchQuery = gql`
  query PostgresExpensesSearch(
    $searchTerm: String!
    $account: AccountReferenceInput
    $host: AccountReferenceInput
    $limit: Int
    $offset: Int
    $defaultLimit: Int! = 10
  ) {
    search(searchTerm: $searchTerm, backend: POSTGRES, account: $account, host: $host, defaultLimit: $defaultLimit) {
      results {
        expenses(limit: $limit, offset: $offset) {
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

type ExpensesSearchVariables = {
  account?: { slug: string };
  host?: { slug: string };
  limit?: number;
  offset?: number;
  defaultLimit?: number;
};

const searchExpenses = (searchTerm: string, variables: ExpensesSearchVariables = {}, remoteUser: User = null) =>
  graphqlQueryV2(expensesSearchQuery, { searchTerm, ...variables }, remoteUser);

/** Returns the expenses results, failing on errors */
const getExpenses = async (searchTerm: string, variables: ExpensesSearchVariables = {}, remoteUser: User = null) => {
  const result = await searchExpenses(searchTerm, variables, remoteUser);
  expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
  return result.data.search.results.expenses;
};

const getIds = async (searchTerm: string, variables: ExpensesSearchVariables = {}, remoteUser: User = null) => {
  const expenses = await getExpenses(searchTerm, variables, remoteUser);
  return expenses.collection.nodes.map(node => node.id);
};

const gqlId = (expense: Expense) => idEncode(expense.id, 'expense');

describe('server/graphql/v2/query/SearchQuery (PostgreSQL, Expenses)', () => {
  let sandbox: sinon.SinonSandbox;

  before(async () => {
    await resetTestDB();
    await resetCaches(); // Search rate-limit counters are keyed by user ID, which the DB reset reuses
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(OpenSearchClientLib, 'isOpenSearchConfigured').returns(false);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('matching', () => {
    let described: Expense, withItems: Expense, twoMatchingItems: Expense, editedItem: ExpenseItem;

    before(async () => {
      const collective = await fakeCollective();
      described = await fakeExpense({
        CollectiveId: collective.id,
        description: 'Quetzal workshop catering',
        longDescription: '<p>Snacks for the <b>tapirfest</b>&nbsp;meetup</p>',
        currency: 'EUR',
        status: 'APPROVED',
        items: [{ description: 'Plain item' }],
      });
      withItems = await fakeExpense({
        CollectiveId: collective.id,
        description: 'Monthly reimbursement',
        items: [{ description: 'Zebu harness repair' }, { description: '<p>Gecko <i>lantern</i></p>' }],
      });
      twoMatchingItems = await fakeExpense({
        CollectiveId: collective.id,
        description: 'Another reimbursement',
        items: [{ description: 'Ocelot ticket outbound' }, { description: 'Ocelot ticket return' }],
      });
      editedItem = await fakeExpenseItem({ ExpenseId: twoMatchingItems.id, description: 'Marmoset taxi' });
    });

    it('finds an Expense by its description', async () => {
      const expenses = await getExpenses('quetzal catering');
      expect(expenses.collection.totalCount).to.eq(1);
      expect(expenses.collection.nodes.map(n => n.id)).to.deep.eq([gqlId(described)]);
      expect(expenses.maxScore).to.eq(expenses.scores[0].score);
    });

    it('requires all the words across the public fields, including the long description, currency and status', async () => {
      expect(await getIds('quetzal tapirfest')).to.deep.eq([gqlId(described)]); // HTML stripped
      expect(await getIds('quetzal eur approved')).to.deep.eq([gqlId(described)]);
      expect(await getIds('quetzal usd')).to.deep.eq([]);
      expect(await getIds('quetzal nbsp')).to.deep.eq([]);
    });

    it('finds an Expense through all the words of one of its items', async () => {
      expect(await getIds('zebu harness')).to.deep.eq([gqlId(withItems)]);
      expect(await getIds('gecko lantern')).to.deep.eq([gqlId(withItems)]); // HTML stripped
    });

    it('does not match words split between the Expense and an item, or between two items', async () => {
      expect(await getIds('monthly zebu')).to.deep.eq([]);
      expect(await getIds('zebu gecko')).to.deep.eq([]);
    });

    it('returns an Expense only once when several items match', async () => {
      const expenses = await getExpenses('ocelot ticket');
      expect(expenses.collection.totalCount).to.eq(1);
      expect(expenses.collection.nodes.map(n => n.id)).to.deep.eq([gqlId(twoMatchingItems)]);
      expect(expenses.scores).to.have.length(1);
    });

    it('reflects item edits and deletions', async () => {
      expect(await getIds('marmoset taxi')).to.deep.eq([gqlId(twoMatchingItems)]);
      await editedItem.update({ description: 'Marmoset train' });
      expect(await getIds('marmoset taxi')).to.deep.eq([]);
      expect(await getIds('marmoset train')).to.deep.eq([gqlId(twoMatchingItems)]);
      await editedItem.destroy();
      expect(await getIds('marmoset')).to.deep.eq([]);
    });

    it('finds exact identifiers', async () => {
      const item = (await described.getItems())[0];
      for (const term of [
        String(described.id),
        `#${described.id}`,
        described.publicId,
        idEncode(described.id, 'expense'),
        item.publicId,
      ]) {
        expect(await getIds(term), term).to.include(gqlId(described));
      }
    });

    it('excludes deleted Expenses and the Expenses of deleted or private accounts', async () => {
      const rootUser = await fakeUser({ data: { isRoot: true } });
      const platform = await fakeOrganization({ id: PlatformConstants.PlatformCollectiveId, name: 'Platform' });
      await platform.addUserWithRole(rootUser, 'ADMIN');

      const deleted = await fakeExpense({ description: 'Wallaby deleted', items: [{ description: 'Wallaby item' }] });
      await deleted.destroy({ hooks: false }); // Keeps its items live
      const privateAccount = await fakeCollective({ isPrivate: true });
      await fakeExpense({ CollectiveId: privateAccount.id, description: 'Wallaby private', items: [] });
      const deletedAccount = await fakeCollective();
      await fakeExpense({ CollectiveId: deletedAccount.id, description: 'Wallaby gone', items: [] });
      await deletedAccount.destroy();

      const expenses = await getExpenses('wallaby', {}, rootUser);
      expect(expenses.collection.totalCount).to.eq(0);
      expect(expenses.maxScore).to.eq(0);
    });
  });

  describe('ranking', () => {
    let exact: Expense, parentWords: Expense, itemWords: Expense;
    let ties: Expense[];

    before(async () => {
      // Created in an order that differs from the expected ranking
      itemWords = await fakeExpense({ description: 'Groceries', items: [{ description: 'Dugong snorkel rental' }] });
      parentWords = await fakeExpense({ description: 'Big dugong snorkel trip', items: [] });
      exact = await fakeExpense({ description: 'Dugong Snorkel', items: [] });
      ties = [];
      for (let i = 0; i < 3; i++) {
        ties.push(await fakeExpense({ description: `Narwhal batch ${i}`, items: [] }));
      }
    });

    it('ranks an exact description first, then matches on the Expense, then matches on an item only', async () => {
      const expenses = await getExpenses('dugong snorkel');
      expect(expenses.collection.nodes.map(n => n.id)).to.deep.eq([exact, parentWords, itemWords].map(gqlId));
      const scores = expenses.scores.map(s => s.score);
      expect(scores[0]).to.be.within(4000, 4499); // Exact label, not a preferred entity
      expect(scores[1]).to.be.within(3000, 3499);
      expect(scores[2]).to.be.within(3000, scores[1] - 1);
    });

    it('breaks ties by descending ID, consistently across pages', async () => {
      const all = await getIds('narwhal batch');
      expect(all).to.deep.eq([...ties].reverse().map(gqlId));
      const pages = [
        ...(await getIds('narwhal batch', { limit: 2, offset: 0 })),
        ...(await getIds('narwhal batch', { limit: 2, offset: 2 })),
      ];
      expect(pages).to.deep.eq(all);
    });

    it('returns exact totals and an offset-independent maxScore, including on empty later pages', async () => {
      const firstPage = await getExpenses('dugong snorkel', { limit: 1 });
      const lastPage = await getExpenses('dugong snorkel', { limit: 1, offset: 2 });
      const emptyPage = await getExpenses('dugong snorkel', { limit: 1, offset: 100 });
      for (const page of [firstPage, lastPage, emptyPage]) {
        expect(page.collection.totalCount).to.eq(3);
        expect(page.maxScore).to.eq(firstPage.scores[0].score);
      }
      expect(emptyPage.collection.nodes).to.be.empty;
      expect(emptyPage.collection.offset).to.eq(100);
    });
    it('returns only exact totals with a limit of 0 (e.g. the counts of the other result tabs)', async () => {
      // Same as the search results page, which only needs the totals of the entities of the other tabs
      const expenses = await getExpenses('dugong snorkel', { limit: 0, defaultLimit: 0 });
      expect(expenses.collection.totalCount).to.eq(3);
      expect(expenses.collection.nodes).to.be.empty;
      expect(expenses.maxScore).to.be.within(4000, 4499);
    });
  });

  describe('permissions and scopes', () => {
    let hostAdmin: User, otherHostAdmin: User, collectiveAdmin: User, projectAdmin: User, payee: User;
    let randomUser: User, rootUser: User;
    let host: Collective, otherHost: Collective, collective: Collective, project: Collective;
    let collectiveExpense: Expense, projectExpense: Expense, otherHostExpense: Expense, restricted: Expense;

    before(async () => {
      [hostAdmin, otherHostAdmin, collectiveAdmin, projectAdmin, payee, randomUser] = await Promise.all([
        fakeUser(),
        fakeUser(),
        fakeUser(),
        fakeUser(),
        fakeUser(),
        fakeUser(),
      ]);
      rootUser = await fakeUser({ data: { isRoot: true } });
      const platform =
        (await Collective.findByPk(PlatformConstants.PlatformCollectiveId)) ||
        (await fakeOrganization({ id: PlatformConstants.PlatformCollectiveId, name: 'Platform' }));
      await platform.addUserWithRole(rootUser, 'ADMIN');

      host = await fakeActiveHost({ admin: hostAdmin });
      otherHost = await fakeActiveHost({ admin: otherHostAdmin });
      collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin });
      project = await fakeProject({
        ParentCollectiveId: collective.id,
        HostCollectiveId: host.id,
        admin: projectAdmin,
      });

      // No HostCollectiveId on the Expense: the host is the account's active host
      collectiveExpense = await fakeExpense({
        CollectiveId: collective.id,
        description: 'Kinkajou supplies',
        items: [],
      });
      projectExpense = await fakeExpense({ CollectiveId: project.id, description: 'Kinkajou banners', items: [] });
      // The Expense's own host wins over the account's host
      otherHostExpense = await fakeExpense({
        CollectiveId: collective.id,
        HostCollectiveId: otherHost.id,
        description: 'Kinkajou legacy',
        items: [],
      });
      restricted = await fakeExpense({
        CollectiveId: project.id,
        FromCollectiveId: payee.CollectiveId,
        UserId: payee.id,
        description: 'Kinkajou restricted',
        privateMessage: '<p>Secretmessageword</p>',
        invoiceInfo: 'Secretinvoiceword Street',
        reference: 'REF-Secretrefword-42',
        items: [],
      });
    });

    it('only lets permitted users search the private message, invoice information and reference', async () => {
      const expectations: Array<[string, User | null, boolean]> = [
        ['unauthenticated', null, false],
        ['random user', randomUser, false],
        ['admin of another host', otherHostAdmin, false],
        ['payee', payee, true],
        ['project admin', projectAdmin, true],
        ['parent collective admin', collectiveAdmin, true],
        ['host admin', hostAdmin, true],
        ['root', rootUser, true],
      ];

      for (const [label, user, canSearch] of expectations) {
        for (const term of ['secretmessageword', 'secretinvoiceword', 'secretrefword', 'REF-Secretrefword-42']) {
          const expenses = await getExpenses(term, {}, user);
          expect(expenses.collection.totalCount, `${label}: ${term}`).to.eq(canSearch ? 1 : 0);
        }
        // Restricted-only words never affect other results
        const combined = await getExpenses('kinkajou secretmessageword', {}, user);
        expect(combined.collection.totalCount, label).to.eq(canSearch ? 1 : 0);
        expect(combined.maxScore, label).to.eq(canSearch ? combined.scores[0].score : 0);
      }
    });

    it('finds the exact reference in the identifier band', async () => {
      const expenses = await getExpenses('REF-Secretrefword-42', {}, hostAdmin);
      expect(expenses.collection.nodes.map(n => n.id)).to.deep.eq([gqlId(restricted)]);
      expect(expenses.scores[0].score).to.be.within(5000, 5499);
    });

    it('does not let OAuth tokens without the expenses scope search restricted fields', async () => {
      const query = (scope: OAuthScopes[]) =>
        fakeUserToken({ scope, UserId: hostAdmin.id }).then(token =>
          oAuthGraphqlQueryV2(expensesSearchQuery, { searchTerm: 'secretinvoiceword' }, token),
        );

      const withoutScope = await query([OAuthScopes.account]);
      expect(withoutScope.errors).to.not.exist;
      expect(withoutScope.data.search.results.expenses.collection.totalCount).to.eq(0);
      const withScope = await query([OAuthScopes.expenses]);
      expect(withScope.data.search.results.expenses.collection.totalCount).to.eq(1);
    });

    it('applies permission changes immediately', async () => {
      const newAdmin = await fakeUser();
      expect((await getExpenses('secretinvoiceword', {}, newAdmin)).collection.totalCount).to.eq(0);
      await host.addUserWithRole(newAdmin, 'ADMIN');
      expect((await getExpenses('secretinvoiceword', {}, newAdmin)).collection.totalCount).to.eq(1);
    });

    it('scopes Expenses to the account, its children and its payee Expenses', async () => {
      const all = [collectiveExpense, projectExpense, otherHostExpense, restricted].map(gqlId);
      expect(await getIds('kinkajou', { account: { slug: collective.slug } })).to.have.members(all);
      expect(await getIds('kinkajou', { account: { slug: project.slug } })).to.have.members(
        [projectExpense, restricted].map(gqlId),
      );
      const payeeAccount = await payee.getCollective();
      expect(await getIds('kinkajou', { account: { slug: payeeAccount.slug } })).to.deep.eq([gqlId(restricted)]);
    });

    it('scopes Expenses to their host', async () => {
      expect(await getIds('kinkajou', { host: { slug: host.slug } })).to.have.members(
        [collectiveExpense, projectExpense, restricted].map(gqlId),
      );
      expect(await getIds('kinkajou', { host: { slug: otherHost.slug } })).to.deep.eq([gqlId(otherHostExpense)]);
    });

    it('intersects account and host scopes', async () => {
      expect(await getIds('kinkajou', { account: { slug: project.slug }, host: { slug: host.slug } })).to.have.members(
        [projectExpense, restricted].map(gqlId),
      );
      expect(await getIds('kinkajou', { account: { slug: project.slug }, host: { slug: otherHost.slug } })).to.be.empty;
    });
  });
});
