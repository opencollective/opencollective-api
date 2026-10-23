/**
 * PostgreSQL search provider, Transactions (opencollective#8941).
 *
 * Through the GraphQL V2 `search` query with real PostgreSQL fixtures, without an OpenSearch cluster. Fixtures use
 * made-up words so that tests don't match each other's transactions.
 */

import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import sinon from 'sinon';
import { v4 as uuid } from 'uuid';

import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import PlatformConstants from '../../../../../server/constants/platform';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import * as OpenSearchClientLib from '../../../../../server/lib/open-search/client';
import models, { Collective, Transaction, User } from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeOrganization,
  fakeProject,
  fakeTransaction,
  fakeUser,
  fakeUserToken,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetCaches, resetTestDB } from '../../../../utils';

const transactionsSearchQuery = gql`
  query PostgresTransactionsSearch(
    $searchTerm: String!
    $account: AccountReferenceInput
    $host: AccountReferenceInput
    $limit: Int
    $offset: Int
  ) {
    search(searchTerm: $searchTerm, backend: POSTGRES, account: $account, host: $host) {
      results {
        transactions(limit: $limit, offset: $offset) {
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
              legacyId
            }
          }
        }
      }
    }
  }
`;

type TransactionsSearchVariables = {
  account?: { slug: string };
  host?: { slug: string };
  limit?: number;
  offset?: number;
};

const searchTransactions = (searchTerm: string, variables: TransactionsSearchVariables = {}, remoteUser: User = null) =>
  graphqlQueryV2(transactionsSearchQuery, { searchTerm, ...variables }, remoteUser);

const getTransactions = async (
  searchTerm: string,
  variables: TransactionsSearchVariables = {},
  remoteUser: User = null,
) => {
  const result = await searchTransactions(searchTerm, variables, remoteUser);
  expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
  return result.data.search.results.transactions;
};

/** Database IDs of the matched transactions, in result order */
const getIds = async (searchTerm: string, variables: TransactionsSearchVariables = {}, remoteUser: User = null) => {
  const transactions = await getTransactions(searchTerm, variables, remoteUser);
  return transactions.collection.nodes.map(node => node.legacyId);
};

/** Provider JSON as stored on Transactions (partial provider objects) */
const json = (data: Record<string, unknown>) => data as Transaction['data'];

/** A CREDIT on `CollectiveId` and its DEBIT counterpart on `FromCollectiveId`, sharing a group and JSON data */
const fakeDoubleEntry = async (data: Parameters<typeof fakeTransaction>[0]) => {
  const credit = await fakeTransaction({ amount: 1000, ...data }, { createDoubleEntry: true });
  const debit = await models.Transaction.findOne({
    where: { TransactionGroup: credit.TransactionGroup, kind: credit.kind, type: 'DEBIT' },
  });
  return { credit, debit };
};

describe('server/graphql/v2/query/SearchQuery (PostgreSQL, transactions)', () => {
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
    let collective: Collective;

    before(async () => {
      collective = await fakeCollective({ name: 'Transaction Matching Collective' });
    });

    it('finds a transaction by the words of its description', async () => {
      const transaction = await fakeTransaction({
        CollectiveId: collective.id,
        kind: TransactionKind.CONTRIBUTION,
        description: 'Monthly gift for the Pangolin Sanctuary',
      });

      const transactions = await getTransactions('pangolin sanctuary');
      expect(transactions.collection.nodes.map(n => n.legacyId)).to.deep.eq([transaction.id]);
      expect(transactions.scores[0].id).to.eq(transaction.uuid); // Transactions are identified by UUID in GraphQL
      expect(transactions.collection.nodes[0].id).to.eq(transaction.uuid);
      expect(await getIds('SANCTUARIES Pangolín')).to.deep.eq([transaction.id]); // Case, accents, stemming
      expect(await getIds('pangolin unrelatedword')).to.deep.eq([]);
    });

    it('finds exact identifiers: ID, public ID, UUID and transaction group', async () => {
      const { credit, debit } = await fakeDoubleEntry({
        CollectiveId: collective.id,
        kind: TransactionKind.CONTRIBUTION,
        description: 'Identifier lookup',
      });

      for (const [term, expected] of [
        [String(credit.id), [credit.id]],
        [`#${credit.id}`, [credit.id]],
        [credit.publicId, [credit.id]],
        [credit.uuid, [credit.id]],
        [credit.uuid.toUpperCase(), [credit.id]],
        [credit.TransactionGroup, [credit.id, debit.id]],
      ] as const) {
        const transactions = await getTransactions(term);
        expect(
          transactions.collection.nodes.map(n => n.legacyId),
          term,
        ).to.have.members(expected);
        expect(transactions.collection.totalCount, term).to.eq(expected.length);
        expect(transactions.scores[0].score, term).to.be.within(5000, 5499);
      }

      // Public IDs of other entities don't match
      expect(await getIds(collective.publicId)).to.deep.eq([]);
    });

    it('ranks an exact description above transactions that contain the words', async () => {
      const partial = await fakeTransaction({
        CollectiveId: collective.id,
        kind: TransactionKind.CONTRIBUTION,
        description: 'Gift to the Quokka Fund, thanks',
      });
      const exact = await fakeTransaction({
        CollectiveId: collective.id,
        kind: TransactionKind.CONTRIBUTION,
        description: 'Quokka  FUND',
      });
      const transactions = await getTransactions('quokka fund');
      expect(transactions.collection.nodes.map(n => n.legacyId)).to.deep.eq([exact.id, partial.id]);
      expect(transactions.scores[0].score).to.be.within(4000, 4499);
      expect(transactions.scores[1].score).to.be.within(3000, 3499);
      expect(transactions.maxScore).to.eq(transactions.scores[0].score);
    });

    it('finds transactions by kind and type when the input is one of their values', async () => {
      const account = await fakeCollective();
      const { credit, debit } = await fakeDoubleEntry({
        CollectiveId: account.id,
        kind: TransactionKind.PAYMENT_PROCESSOR_COVER,
        description: 'Covered fees',
      });

      const scope = { account: { slug: account.slug } };
      expect(await getIds('PAYMENT_PROCESSOR_COVER', scope)).to.deep.eq([credit.id]);
      expect(await getIds('payment processor cover', scope)).to.deep.eq([credit.id]);
      expect(await getIds('credit', scope)).to.deep.eq([credit.id]);
      expect(
        await getIds('payment processor cover', { account: { slug: (await debit.getCollective()).slug } }),
      ).to.deep.eq([debit.id]);
      expect(await getIds('debit', scope)).to.deep.eq([]);
      expect(await getIds('expense', scope)).to.deep.eq([]);
    });
  });
  describe('pagination', () => {
    it('returns exact totals, stable ties and an offset-independent maxScore, including on empty later pages', async () => {
      const collective = await fakeCollective();
      const transactions = [];
      for (let i = 0; i < 3; i++) {
        transactions.push(
          await fakeTransaction({
            CollectiveId: collective.id,
            kind: TransactionKind.ADDED_FUNDS,
            description: `Wombat grant ${i}`,
          }),
        );
      }

      const all = await getTransactions('wombat grant');
      expect(all.collection.nodes.map(n => n.legacyId)).to.deep.eq(transactions.map(t => t.id).reverse());
      const pages = [];
      for (const offset of [0, 2, 4]) {
        const page = await getTransactions('wombat grant', { limit: 2, offset });
        expect(page.collection.totalCount).to.eq(3);
        expect(page.maxScore).to.eq(all.maxScore);
        expect(page.scores.map(s => s.id)).to.deep.eq(page.collection.nodes.map(n => n.id));
        pages.push(...page.collection.nodes.map(n => n.legacyId));
      }
      expect(pages).to.deep.eq(all.collection.nodes.map(n => n.legacyId));
    });
  });

  describe('eligibility, merchant IDs, permissions and scopes', () => {
    let hostAdmin: User, collectiveAdmin: User, contributor: User, randomUser: User, rootUser: User;
    let host: Collective, collective: Collective, project: Collective, otherCollective: Collective;
    let contribution: Transaction, contributionDebit: Transaction, platformTip: Transaction, toProject: Transaction;
    let elsewhere: Transaction;

    before(async () => {
      hostAdmin = await fakeUser();
      collectiveAdmin = await fakeUser();
      contributor = await fakeUser();
      randomUser = await fakeUser();
      rootUser = await fakeUser({ data: { isRoot: true } });
      const platform = await fakeOrganization({ id: PlatformConstants.PlatformCollectiveId, name: 'Platform' });
      await platform.addUserWithRole(rootUser, 'ADMIN');

      host = await fakeActiveHost({ name: 'Tapir Host', slug: 'tapir-host', admin: hostAdmin });
      collective = await fakeCollective({
        slug: 'tapir-collective',
        HostCollectiveId: host.id,
        admin: collectiveAdmin,
      });
      project = await fakeProject({ slug: 'tapir-project', ParentCollectiveId: collective.id });
      otherCollective = await fakeCollective({ slug: 'tapir-elsewhere' });

      // A Stripe contribution: CREDIT on the collective (hosted), DEBIT on the contributor (no host)
      const TransactionGroup = uuid();
      const data = json({ charge: { id: 'ch_TAPIRCHARGE001' } });
      const common = { TransactionGroup, data, kind: TransactionKind.CONTRIBUTION };
      contribution = await fakeTransaction({
        ...common,
        type: 'CREDIT',
        CollectiveId: collective.id,
        FromCollectiveId: contributor.CollectiveId,
        HostCollectiveId: host.id,
        description: 'Tapir donation',
      });
      contributionDebit = await fakeTransaction({
        ...common,
        type: 'DEBIT',
        amount: -1000,
        CollectiveId: contributor.CollectiveId,
        FromCollectiveId: collective.id,
        HostCollectiveId: null,
        description: 'Tapir donation',
      });
      // Its platform tip, on the host's books: merchant ID of the related contribution
      platformTip = await fakeTransaction({
        TransactionGroup,
        kind: TransactionKind.PLATFORM_TIP,
        type: 'CREDIT',
        CollectiveId: host.id,
        FromCollectiveId: contributor.CollectiveId,
        HostCollectiveId: host.id,
        description: 'Platform tip',
      });

      toProject = await fakeTransaction({
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: project.id,
        HostCollectiveId: host.id,
        description: 'Tapir donation for the project',
      });
      elsewhere = await fakeTransaction({
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: otherCollective.id,
        FromCollectiveId: collective.id,
        description: 'Unrelated tapir donation',
      });

      // Never searchable, even for root
      const privateCollective = await fakeCollective({ isPrivate: true, HostCollectiveId: host.id });
      await fakeTransaction({ CollectiveId: privateCollective.id, description: 'Tapir donation to a private account' });
      await fakeTransaction({
        FromCollectiveId: privateCollective.id,
        description: 'Tapir donation from a private account',
      });
      const privateHost = await fakeActiveHost({ isPrivate: true });
      await fakeTransaction({ HostCollectiveId: privateHost.id, description: 'Tapir donation on a private host' });
      await (await fakeTransaction({ CollectiveId: collective.id, description: 'Deleted tapir donation' })).destroy();
      const deletedCollective = await fakeCollective({ HostCollectiveId: host.id });
      await fakeTransaction({ CollectiveId: deletedCollective.id, description: 'Tapir donation to a deleted account' });
      await deletedCollective.destroy();
    });

    it('only returns transactions of eligible accounts and hosts, even for root', async () => {
      const expected = [contribution.id, contributionDebit.id, toProject.id, elsewhere.id];
      expect(await getIds('tapir donation')).to.have.members(expected);
      expect(await getIds('tapir donation', {}, rootUser)).to.have.members(expected);
      expect((await getTransactions('tapir donation', {}, rootUser)).collection.totalCount).to.eq(4);
    });

    it('only lets host admins and root search merchant IDs, on the rows of their host', async () => {
      const expectations: Array<[string, User | null, number[]]> = [
        ['unauthenticated', null, []],
        ['random user', randomUser, []],
        ['contributor', contributor, []],
        ['collective admin', collectiveAdmin, []],
        ['host admin', hostAdmin, [contribution.id, platformTip.id]],
        ['root', rootUser, [contribution.id, contributionDebit.id, platformTip.id]],
      ];

      for (const [label, user, expected] of expectations) {
        const transactions = await getTransactions('ch_TAPIRCHARGE001', {}, user);
        expect(transactions.collection.totalCount, label).to.eq(expected.length);
        expect(
          transactions.collection.nodes.map(n => n.legacyId),
          label,
        ).to.have.members(expected);
        expect(transactions.maxScore, label).to.eq(expected.length ? 5000 : 0);
        // Restricted-only terms never affect other results
        const combined = await getTransactions('tapir ch_TAPIRCHARGE001', {}, user);
        expect(combined.collection.totalCount, label).to.eq(0);
      }

      // Exact match only
      expect(await getIds('ch_TAPIRCHARGE00', {}, hostAdmin)).to.deep.eq([]);
    });

    it('does not let OAuth tokens without the transactions scope search merchant IDs', async () => {
      const query = (scope: OAuthScopes[]) =>
        fakeUserToken({ scope, UserId: hostAdmin.id }).then(token =>
          oAuthGraphqlQueryV2(transactionsSearchQuery, { searchTerm: 'ch_TAPIRCHARGE001' }, token),
        );

      const withoutScope = await query([OAuthScopes.expenses]);
      expect(withoutScope.errors).to.not.exist;
      expect(withoutScope.data.search.results.transactions.collection.totalCount).to.eq(0);
      const withScope = await query([OAuthScopes.transactions]);
      expect(withScope.data.search.results.transactions.collection.totalCount).to.eq(2);
    });

    it('derives merchant IDs from the kind, the JSON sources and the related contribution, live', async () => {
      // The first non-empty source wins, by kind
      const paypal = await fakeTransaction({
        kind: TransactionKind.CONTRIBUTION,
        HostCollectiveId: host.id,
        data: json({ charge: { id: '' }, paypalCaptureId: 'TAPIRCAPTURE01', refund: { id: 'TAPIRREFUND01' } }),
      });
      const wise = await fakeTransaction({
        kind: TransactionKind.EXPENSE,
        HostCollectiveId: host.id,
        // eslint-disable-next-line camelcase
        data: json({ transfer: { id: 4242424201 }, transaction_id: 'TAPIRPAYOUT01' }),
      });
      // Same JSON, but not a kind that has a merchant ID
      await fakeTransaction({ kind: TransactionKind.HOST_FEE, HostCollectiveId: host.id, data: paypal.data });
      expect(await getIds('TAPIRCAPTURE01', {}, hostAdmin)).to.deep.eq([paypal.id]);
      expect(await getIds('TAPIRREFUND01', {}, hostAdmin)).to.deep.eq([]);
      expect(await getIds('4242424201', {}, hostAdmin)).to.deep.eq([wise.id]);
      expect(await getIds('TAPIRPAYOUT01', {}, hostAdmin)).to.deep.eq([]);

      // Expenses without one: the Expense's transaction ID
      const expense = await fakeExpense({ data: { transactionId: 'TAPIRVIRTUALCARD01' } });
      const cardPayment = await fakeTransaction({
        kind: TransactionKind.EXPENSE,
        ExpenseId: expense.id,
        HostCollectiveId: host.id,
        data: {},
      });
      expect(await getIds('TAPIRVIRTUALCARD01', {}, hostAdmin)).to.deep.eq([cardPayment.id]);

      // Source changes apply immediately
      await paypal.update({ data: json({ paypalCaptureId: 'TAPIRCAPTURE02' }) });
      expect(await getIds('TAPIRCAPTURE01', {}, hostAdmin)).to.deep.eq([]);
      expect(await getIds('TAPIRCAPTURE02', {}, hostAdmin)).to.deep.eq([paypal.id]);
      await expense.update({ data: { transactionId: 'TAPIRVIRTUALCARD02' } });
      expect(await getIds('TAPIRVIRTUALCARD01', {}, hostAdmin)).to.deep.eq([]);
      await cardPayment.update({ data: json({ transaction: { id: 'TAPIRVIRTUALCARD03' } }) });
      expect(await getIds('TAPIRVIRTUALCARD02', {}, hostAdmin)).to.deep.eq([]);
      expect(await getIds('TAPIRVIRTUALCARD03', {}, hostAdmin)).to.deep.eq([cardPayment.id]);

      // Platform tips follow their contribution
      await contribution.update({ data: json({ charge: { id: 'ch_TAPIRCHARGE002' } }) });
      expect(await getIds('ch_TAPIRCHARGE002', {}, hostAdmin)).to.have.members([contribution.id, platformTip.id]);
      await contribution.destroy();
      expect(await getIds('ch_TAPIRCHARGE002', {}, hostAdmin)).to.deep.eq([]);
      await contribution.restore();

      // Platform rows of revenue collected directly by the platform show the Stripe application fee instead
      const TransactionGroup = uuid();
      await fakeTransaction({
        TransactionGroup,
        type: 'CREDIT',
        kind: TransactionKind.CONTRIBUTION,
        HostCollectiveId: host.id,
        data: json({
          // eslint-disable-next-line camelcase
          charge: { id: 'ch_TAPIRDIRECT01', application_fee: 'fee_TAPIR01' },
          isPlatformRevenueDirectlyCollected: true,
        }),
      });
      const platformRow = await fakeTransaction({
        TransactionGroup,
        type: 'CREDIT',
        kind: TransactionKind.PLATFORM_TIP,
        HostCollectiveId: PlatformConstants.PlatformCollectiveId,
      });
      expect(await getIds('ch_TAPIRDIRECT01', {}, rootUser)).to.not.include(platformRow.id);
    });

    it('scopes transactions to the ledger of the account and its children', async () => {
      expect(await getIds('tapir donation', { account: { slug: collective.slug } })).to.have.members([
        contribution.id,
        toProject.id,
      ]);
      expect(await getIds('tapir donation', { account: { slug: project.slug } })).to.deep.eq([toProject.id]);
    });

    it('scopes transactions to their host', async () => {
      expect(await getIds('tapir donation', { host: { slug: host.slug } })).to.have.members([
        contribution.id,
        toProject.id,
      ]);
    });

    it('intersects account and host scopes', async () => {
      const otherHost = await fakeActiveHost({ slug: 'tapir-other-host' });
      const hostedElsewhere = await fakeTransaction({
        CollectiveId: collective.id,
        HostCollectiveId: otherHost.id,
        description: 'Tapir donation from the old host',
      });
      expect(
        await getIds('tapir donation', { account: { slug: collective.slug }, host: { slug: host.slug } }),
      ).to.have.members([contribution.id, toProject.id]);
      expect(
        await getIds('tapir donation', { account: { slug: collective.slug }, host: { slug: otherHost.slug } }),
      ).to.deep.eq([hostedElsewhere.id]);
    });

    it('reflects Transaction and Account changes immediately', async () => {
      await elsewhere.update({ description: 'Renamed okapi donation' });
      expect(await getIds('okapi')).to.deep.eq([elsewhere.id]);
      expect(await getIds('tapir donation')).to.not.include(elsewhere.id);

      await otherCollective.update({ isPrivate: true });
      expect(await getIds('okapi', {}, rootUser)).to.deep.eq([]);
      await otherCollective.update({ isPrivate: false });
      expect(await getIds('okapi')).to.deep.eq([elsewhere.id]);
    });
  });
  describe('capped totals', () => {
    const cappedQuery = gql`
      query PostgresTransactionsSearchCapped($searchTerm: String!, $limit: Int, $offset: Int) {
        search(searchTerm: $searchTerm, backend: POSTGRES) {
          results {
            transactions(limit: $limit, offset: $offset) {
              totalCountIsCapped
              maxScore
              scores {
                score
              }
              collection {
                totalCount
                nodes {
                  legacyId
                }
              }
            }
          }
        }
      }
    `;

    const searchCapped = async (searchTerm: string, variables: { limit?: number; offset?: number } = {}) => {
      const result = await graphqlQueryV2(cappedQuery, { searchTerm, ...variables });
      expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
      return result.data.search.results.transactions;
    };

    let exactId: number;
    let wordIds: number[];

    before(async () => {
      const collective = await fakeCollective({ slug: 'capped-collective' });
      // The exact description is the oldest: it must still come first
      exactId = (await fakeTransaction({ CollectiveId: collective.id, description: 'Quetzal tribute' })).id;
      wordIds = [];
      for (let i = 0; i < 14; i++) {
        const transaction = await fakeTransaction({ CollectiveId: collective.id, description: `Quetzal tribute ${i}` });
        wordIds.push(transaction.id);
      }
      wordIds.reverse(); // Newest first
    });

    it('returns exact totals below the cap', async () => {
      const transactions = await searchCapped('quetzal tribute', { limit: 3 });
      expect(transactions.totalCountIsCapped).to.be.false;
      expect(transactions.collection.totalCount).to.eq(15);
      expect(transactions.collection.nodes.map(node => node.legacyId)).to.deep.eq([exactId, ...wordIds.slice(0, 2)]);
    });

    it('caps totals above the cap, with the same pages and maxScore', async () => {
      sandbox.stub(config.search.postgres, 'maxCountedMatches').value(10);

      const firstPage = await searchCapped('quetzal tribute', { limit: 4 });
      expect(firstPage.totalCountIsCapped).to.be.true;
      expect(firstPage.collection.totalCount).to.eq(10);
      expect(firstPage.collection.nodes.map(node => node.legacyId)).to.deep.eq([exactId, ...wordIds.slice(0, 3)]);
      expect(firstPage.scores[0].score).to.be.greaterThan(firstPage.scores[1].score);

      // Pages beyond the cap still work, and maxScore doesn't depend on the offset
      const lastPage = await searchCapped('quetzal tribute', { limit: 4, offset: 12 });
      expect(lastPage.totalCountIsCapped).to.be.true;
      expect(lastPage.maxScore).to.eq(firstPage.maxScore);
      expect(lastPage.collection.nodes.map(node => node.legacyId)).to.deep.eq(wordIds.slice(11));

      const selective = await searchCapped('quetzal tribute 7');
      expect(selective.totalCountIsCapped).to.be.false;
      expect(selective.collection.totalCount).to.eq(1);
    });
  });
});
