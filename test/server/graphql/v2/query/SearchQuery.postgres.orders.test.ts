/**
 * PostgreSQL search provider, Orders/Contributions (opencollective#8940).
 *
 * Through the GraphQL V2 `search` query with real PostgreSQL fixtures, without an OpenSearch cluster. Fixtures use
 * made-up words so that tests don't match each other's contributions.
 */

import { expect } from 'chai';
import gql from 'fake-tag';
import sinon from 'sinon';

import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import PlatformConstants from '../../../../../server/constants/platform';
import { idDecode, idEncode } from '../../../../../server/graphql/v2/identifiers';
import * as OpenSearchClientLib from '../../../../../server/lib/open-search/client';
import { Collective, Order, Subscription, User } from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeOrder,
  fakeOrganization,
  fakeProject,
  fakeSubscription,
  fakeUser,
  fakeUserToken,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetTestDB } from '../../../../utils';

const ordersSearchQuery = gql`
  query PostgresOrdersSearch(
    $searchTerm: String!
    $account: AccountReferenceInput
    $host: AccountReferenceInput
    $limit: Int
    $offset: Int
  ) {
    search(searchTerm: $searchTerm, backend: POSTGRES, account: $account, host: $host) {
      results {
        orders(limit: $limit, offset: $offset) {
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

type OrdersSearchVariables = {
  account?: { slug: string };
  host?: { slug: string };
  limit?: number;
  offset?: number;
};

const searchOrders = (searchTerm: string, variables: OrdersSearchVariables = {}, remoteUser: User = null) =>
  graphqlQueryV2(ordersSearchQuery, { searchTerm, ...variables }, remoteUser);

const getOrders = async (searchTerm: string, variables: OrdersSearchVariables = {}, remoteUser: User = null) => {
  const result = await searchOrders(searchTerm, variables, remoteUser);
  expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
  return result.data.search.results.orders;
};

/** Database IDs of the matched orders, in result order */
const getIds = async (searchTerm: string, variables: OrdersSearchVariables = {}, remoteUser: User = null) => {
  const orders = await getOrders(searchTerm, variables, remoteUser);
  return orders.collection.nodes.map(node => idDecode(node.id, 'order'));
};

describe('server/graphql/v2/query/SearchQuery (PostgreSQL, orders)', () => {
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

  describe('matching', () => {
    let collective: Collective, described: Order;

    before(async () => {
      collective = await fakeCollective({ name: 'Order Matching Collective' });
      described = await fakeOrder({
        CollectiveId: collective.id,
        description: 'Monthly gift for the Ocelot Sanctuary',
      });
    });

    it('finds a contribution by the words of its description', async () => {
      expect(await getIds('ocelot sanctuary')).to.deep.eq([described.id]);
      expect(await getIds('SANCTUARIES Océlot')).to.deep.eq([described.id]); // Case, accents, stemming
      expect(await getIds('ocelot unrelatedword')).to.deep.eq([]);
    });

    it('finds exact identifiers', async () => {
      for (const term of [
        String(described.id),
        `#${described.id}`,
        described.publicId,
        idEncode(described.id, 'order'),
      ]) {
        const orders = await getOrders(term);
        expect(
          orders.collection.nodes.map(n => idDecode(n.id, 'order')),
          term,
        ).to.deep.eq([described.id]);
        expect(orders.scores[0].score, term).to.be.within(5000, 5499);
      }

      // Public IDs of other entities don't match
      expect(await getIds(collective.publicId)).to.deep.eq([]);
    });

    it('ranks an exact description above contributions that contain the words', async () => {
      const partial = await fakeOrder({ CollectiveId: collective.id, description: 'Gift to the Serval Fund, thanks' });
      const exact = await fakeOrder({ CollectiveId: collective.id, description: 'Serval  FUND' });
      const orders = await getOrders('serval fund');
      expect(orders.collection.nodes.map(n => idDecode(n.id, 'order'))).to.deep.eq([exact.id, partial.id]);
      expect(orders.scores[0].score).to.be.within(4000, 4499);
      expect(orders.scores[1].score).to.be.within(3000, 3499);
      expect(orders.maxScore).to.eq(orders.scores[0].score);
    });
  });

  describe('pagination', () => {
    it('returns exact totals, stable ties and an offset-independent maxScore, including on empty later pages', async () => {
      const collective = await fakeCollective();
      const orders = [];
      for (let i = 0; i < 3; i++) {
        orders.push(await fakeOrder({ CollectiveId: collective.id, description: `Fennec pledge ${i}` }));
      }

      const all = await getOrders('fennec pledge');
      expect(all.collection.nodes.map(n => idDecode(n.id, 'order'))).to.deep.eq(orders.map(o => o.id).reverse());
      const pages = [];
      for (const offset of [0, 2, 4]) {
        const page = await getOrders('fennec pledge', { limit: 2, offset });
        expect(page.collection.totalCount).to.eq(3);
        expect(page.maxScore).to.eq(all.maxScore);
        pages.push(...page.collection.nodes.map(n => idDecode(n.id, 'order')));
      }
      expect(pages).to.deep.eq(all.collection.nodes.map(n => idDecode(n.id, 'order')));
    });
  });

  describe('eligibility, permissions and scopes', () => {
    let hostAdmin: User, collectiveAdmin: User, contributor: User, randomUser: User, rootUser: User;
    let host: Collective, collective: Collective, project: Collective, otherCollective: Collective;
    let subscription: Subscription;
    let recurring: Order, toProject: Order, fromCollective: Order, elsewhere: Order;

    before(async () => {
      hostAdmin = await fakeUser();
      collectiveAdmin = await fakeUser();
      contributor = await fakeUser();
      randomUser = await fakeUser();
      rootUser = await fakeUser({ data: { isRoot: true } });
      const platform = await fakeOrganization({ id: PlatformConstants.PlatformCollectiveId, name: 'Platform' });
      await platform.addUserWithRole(rootUser, 'ADMIN');

      host = await fakeActiveHost({ name: 'Margay Host', slug: 'margay-host', admin: hostAdmin });
      collective = await fakeCollective({
        slug: 'margay-collective',
        HostCollectiveId: host.id,
        admin: collectiveAdmin,
      });
      project = await fakeProject({ slug: 'margay-project', ParentCollectiveId: collective.id });
      otherCollective = await fakeCollective({ slug: 'margay-elsewhere' });

      subscription = await fakeSubscription({ paypalSubscriptionId: 'I-MARGAYSUB001' });
      recurring = await fakeOrder({
        CollectiveId: collective.id,
        FromCollectiveId: contributor.CollectiveId,
        CreatedByUserId: contributor.id,
        SubscriptionId: subscription.id,
        description: 'Monthly margay pledge',
      });
      toProject = await fakeOrder({ CollectiveId: project.id, description: 'Margay pledge for the project' });
      fromCollective = await fakeOrder({
        CollectiveId: otherCollective.id,
        FromCollectiveId: collective.id,
        description: 'Margay pledge from the collective',
      });
      elsewhere = await fakeOrder({ CollectiveId: otherCollective.id, description: 'Unrelated margay pledge' });

      // Never searchable, even for root
      const privateCollective = await fakeCollective({ isPrivate: true, HostCollectiveId: host.id });
      await fakeOrder({ CollectiveId: privateCollective.id, description: 'Margay pledge to a private account' });
      await (await fakeOrder({ CollectiveId: collective.id, description: 'Deleted margay pledge' })).destroy();
      const deletedCollective = await fakeCollective({ HostCollectiveId: host.id });
      await fakeOrder({ CollectiveId: deletedCollective.id, description: 'Margay pledge to a deleted account' });
      await deletedCollective.destroy();
    });

    it('only returns contributions of eligible accounts, even for root', async () => {
      const expected = [recurring.id, toProject.id, fromCollective.id, elsewhere.id];
      expect(await getIds('margay pledge')).to.have.members(expected);
      expect(await getIds('margay pledge', {}, rootUser)).to.have.members(expected);
      expect((await getOrders('margay pledge', {}, rootUser)).collection.totalCount).to.eq(4);
    });

    it('only lets host admins and root search PayPal subscription IDs', async () => {
      const expectations: Array<[string, User | null, boolean]> = [
        ['unauthenticated', null, false],
        ['random user', randomUser, false],
        ['contributor', contributor, false],
        ['collective admin', collectiveAdmin, false],
        ['host admin', hostAdmin, true],
        ['root', rootUser, true],
      ];

      for (const [label, user, canSearch] of expectations) {
        const orders = await getOrders('I-MARGAYSUB001', {}, user);
        expect(orders.collection.totalCount, label).to.eq(canSearch ? 1 : 0);
        expect(
          orders.collection.nodes.map(n => idDecode(n.id, 'order')),
          label,
        ).to.deep.eq(canSearch ? [recurring.id] : []);
        expect(orders.maxScore, label).to.eq(canSearch ? orders.scores[0].score : 0);
        // Restricted-only terms never affect other results
        const combined = await getOrders('margay I-MARGAYSUB001', {}, user);
        expect(combined.collection.totalCount, label).to.eq(0);
      }

      // Exact match (index-backed), whatever the case
      expect(await getIds('i-margaysub001', {}, hostAdmin)).to.deep.eq([recurring.id]);
      expect(await getIds('I-MARGAYSUB00', {}, hostAdmin)).to.deep.eq([]);
    });

    it('does not let OAuth tokens without the orders scope search PayPal subscription IDs', async () => {
      const query = (scope: OAuthScopes[]) =>
        fakeUserToken({ scope, UserId: hostAdmin.id }).then(token =>
          oAuthGraphqlQueryV2(ordersSearchQuery, { searchTerm: 'I-MARGAYSUB001' }, token),
        );

      const withoutScope = await query([OAuthScopes.expenses]);
      expect(withoutScope.errors).to.not.exist;
      expect(withoutScope.data.search.results.orders.collection.totalCount).to.eq(0);
      const withScope = await query([OAuthScopes.orders]);
      expect(withScope.data.search.results.orders.collection.totalCount).to.eq(1);
    });

    it('reflects Subscription changes and deletions immediately', async () => {
      await subscription.update({ paypalSubscriptionId: 'I-MARGAYSUB002' });
      expect(await getIds('I-MARGAYSUB001', {}, hostAdmin)).to.deep.eq([]);
      expect(await getIds('I-MARGAYSUB002', {}, hostAdmin)).to.deep.eq([recurring.id]);

      await subscription.destroy();
      expect(await getIds('I-MARGAYSUB002', {}, hostAdmin)).to.deep.eq([]);
      expect(await getIds('I-MARGAYSUB002', {}, rootUser)).to.deep.eq([]);
    });

    it('reflects Contribution and Account changes immediately', async () => {
      await elsewhere.update({ description: 'Renamed caracal pledge' });
      expect(await getIds('caracal')).to.deep.eq([elsewhere.id]);
      expect(await getIds('margay pledge')).to.not.include(elsewhere.id);

      await otherCollective.update({ isPrivate: true });
      expect(await getIds('caracal', {}, rootUser)).to.deep.eq([]);
      await otherCollective.update({ isPrivate: false });
      expect(await getIds('caracal')).to.deep.eq([elsewhere.id]);
    });

    it('scopes contributions to the account, its children, and its own contributions', async () => {
      expect(await getIds('margay pledge', { account: { slug: collective.slug } })).to.have.members([
        recurring.id,
        toProject.id,
        fromCollective.id,
      ]);
      expect(await getIds('margay pledge', { account: { slug: project.slug } })).to.deep.eq([toProject.id]);
    });

    it('scopes contributions to the accounts of a host', async () => {
      expect(await getIds('margay pledge', { host: { slug: host.slug } })).to.have.members([
        recurring.id,
        toProject.id,
      ]);
      expect(await getIds('I-MARGAYSUB001', { host: { slug: host.slug } }, hostAdmin)).to.deep.eq([]);
    });

    it('intersects account and host scopes', async () => {
      // `fromCollective` is in the account scope, but attributed to the other collective's host
      expect(
        await getIds('margay pledge', { account: { slug: collective.slug }, host: { slug: host.slug } }),
      ).to.have.members([recurring.id, toProject.id]);
      const otherHost = await fakeActiveHost({ slug: 'margay-other-host' });
      expect(await getIds('margay pledge', { account: { slug: collective.slug }, host: { slug: otherHost.slug } })).to
        .be.empty;
    });
  });
});
