import { expect } from 'chai';
import gql from 'fake-tag';
import { v4 as uuid } from 'uuid';

import MemberRoles from '../../../../../server/constants/roles';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { sequelize } from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeActivity,
  fakeCollective,
  fakeIncognitoProfile,
  fakeMember,
  fakeTransaction,
  fakeUser,
  randStr,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const communityQuery = gql`
  query Community(
    $host: AccountReferenceInput!
    $account: AccountReferenceInput
    $type: [AccountType]
    $searchTerm: String
    $relation: [CommunityRelationType!]
    $orderBy: OrderByInput
    $totalContributed: AmountRangeInput
    $totalExpended: AmountRangeInput
    $limit: Int!
    $offset: Int!
  ) {
    community(
      host: $host
      account: $account
      type: $type
      searchTerm: $searchTerm
      relation: $relation
      orderBy: $orderBy
      totalContributed: $totalContributed
      totalExpended: $totalExpended
      limit: $limit
      offset: $offset
    ) {
      totalCount
      limit
      offset
      nodes {
        id
        slug
        name
        type
      }
    }
  }
`;

const refreshCommunityMaterializedViews = async () => {
  // CommunityHostTransactionSummary depends on CommunityTransactionSummary which depends on CommunityHostYearlyTransactionSummary
  await sequelize.query('REFRESH MATERIALIZED VIEW "CommunityActivitySummary"');
  await sequelize.query('REFRESH MATERIALIZED VIEW "CommunityTransactionSummary"');
  await sequelize.query('REFRESH MATERIALIZED VIEW "CommunityHostYearlyTransactionSummary"');
  await sequelize.query('REFRESH MATERIALIZED VIEW "CommunityHostTransactionSummary"');
};

describe('server/graphql/v2/query/CommunityQuery', () => {
  let host, hostAdmin, collective, contributor1, contributor2, expenseSubmitter;

  before(async () => {
    await resetTestDB();

    // Create host and admin
    hostAdmin = await fakeUser();
    host = await fakeActiveHost({ admin: hostAdmin });

    // Create a collective under the host
    collective = await fakeCollective({ HostCollectiveId: host.id });

    // Create contributor users
    contributor1 = await fakeUser({}, { name: 'Alice Contributor' });
    contributor2 = await fakeUser({}, { name: 'Bob Contributor' });
    expenseSubmitter = await fakeUser({}, { name: 'Charlie Submitter' });

    // Create BACKER members (which map to CONTRIBUTOR relation)
    await fakeMember({
      CollectiveId: collective.id,
      MemberCollectiveId: contributor1.CollectiveId,
      role: MemberRoles.BACKER,
    });
    await fakeMember({
      CollectiveId: collective.id,
      MemberCollectiveId: contributor2.CollectiveId,
      role: MemberRoles.BACKER,
    });

    // Create an ADMIN member
    await fakeMember({
      CollectiveId: collective.id,
      MemberCollectiveId: expenseSubmitter.CollectiveId,
      role: MemberRoles.ADMIN,
    });

    // Create transactions for contributor1 (contributions)
    const transactionGroup1 = uuid();
    await fakeTransaction({
      type: 'CREDIT',
      kind: TransactionKind.CONTRIBUTION,
      FromCollectiveId: contributor1.CollectiveId,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      amount: 500000, // $5000
      currency: 'USD',
      hostCurrency: 'USD',
      TransactionGroup: transactionGroup1,
    });
    await fakeTransaction({
      type: 'DEBIT',
      kind: TransactionKind.CONTRIBUTION,
      FromCollectiveId: collective.id,
      CollectiveId: contributor1.CollectiveId,
      HostCollectiveId: host.id,
      amount: -500000,
      currency: 'USD',
      hostCurrency: 'USD',
      TransactionGroup: transactionGroup1,
    });

    // Create transactions for contributor2 (smaller contribution)
    const transactionGroup2 = uuid();
    await fakeTransaction({
      type: 'CREDIT',
      kind: TransactionKind.CONTRIBUTION,
      FromCollectiveId: contributor2.CollectiveId,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      amount: 100000, // $1000
      currency: 'USD',
      hostCurrency: 'USD',
      TransactionGroup: transactionGroup2,
    });
    await fakeTransaction({
      type: 'DEBIT',
      kind: TransactionKind.CONTRIBUTION,
      FromCollectiveId: collective.id,
      CollectiveId: contributor2.CollectiveId,
      HostCollectiveId: host.id,
      amount: -100000,
      currency: 'USD',
      hostCurrency: 'USD',
      TransactionGroup: transactionGroup2,
    });

    // Create expense transaction for expenseSubmitter
    const transactionGroup3 = uuid();
    await fakeTransaction({
      type: 'DEBIT',
      kind: TransactionKind.EXPENSE,
      FromCollectiveId: expenseSubmitter.CollectiveId,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      amount: -200000, // $2000 expense
      currency: 'USD',
      hostCurrency: 'USD',
      TransactionGroup: transactionGroup3,
    });
    await fakeTransaction({
      type: 'CREDIT',
      kind: TransactionKind.EXPENSE,
      FromCollectiveId: collective.id,
      CollectiveId: expenseSubmitter.CollectiveId,
      HostCollectiveId: host.id,
      amount: 200000,
      currency: 'USD',
      hostCurrency: 'USD',
      TransactionGroup: transactionGroup3,
    });

    // Refresh materialized views
    await refreshCommunityMaterializedViews();
  });

  describe('authentication and authorization', () => {
    it('requires host admin access', async () => {
      const randomUser = await fakeUser();
      const result = await graphqlQueryV2(
        communityQuery,
        { host: { legacyId: host.id }, limit: 10, offset: 0 },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Only admins of the host can access the community endpoint');
    });

    it('rejects non-host-admin even when using account argument', async () => {
      const collectiveAdmin = await fakeUser();
      await fakeMember({
        CollectiveId: collective.id,
        MemberCollectiveId: collectiveAdmin.CollectiveId,
        role: MemberRoles.ADMIN,
      });
      const result = await graphqlQueryV2(
        communityQuery,
        { host: { legacyId: host.id }, account: { legacyId: collective.id }, limit: 10, offset: 0 },
        collectiveAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Only admins of the host can access the community endpoint');
    });
  });

  describe('basic queries with host filter', () => {
    it('returns community members for a host', async () => {
      const result = await graphqlQueryV2(
        communityQuery,
        { host: { legacyId: host.id }, limit: 100, offset: 0 },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const { community } = result.data;
      expect(community.totalCount).to.be.greaterThan(0);
      expect(community.nodes).to.be.an('array');
      expect(community.limit).to.equal(100);
      expect(community.offset).to.equal(0);
    });

    it('returns community members for a specific account under the host', async () => {
      const result = await graphqlQueryV2(
        communityQuery,
        {
          host: { legacyId: host.id },
          account: { legacyId: collective.id },
          limit: 100,
          offset: 0,
        },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const { community } = result.data;
      expect(community.totalCount).to.be.greaterThan(0);

      const slugs = community.nodes.map(n => n.slug);
      expect(slugs).to.include(contributor1.collective.slug);
      expect(slugs).to.include(contributor2.collective.slug);
      expect(slugs).to.include(expenseSubmitter.collective.slug);
    });
  });

  describe('type filter', () => {
    it('filters by account type', async () => {
      const result = await graphqlQueryV2(
        communityQuery,
        {
          host: { legacyId: host.id },
          type: ['INDIVIDUAL'],
          limit: 100,
          offset: 0,
        },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const { community } = result.data;
      community.nodes.forEach(node => {
        expect(node.type).to.equal('INDIVIDUAL');
      });
    });
  });

  describe('relation filter', () => {
    it('filters by CONTRIBUTOR relation', async () => {
      const result = await graphqlQueryV2(
        communityQuery,
        {
          host: { legacyId: host.id },
          account: { legacyId: collective.id },
          relation: ['CONTRIBUTOR'],
          limit: 100,
          offset: 0,
        },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const { community } = result.data;
      const slugs = community.nodes.map(n => n.slug);
      expect(slugs).to.include(contributor1.collective.slug);
      expect(slugs).to.include(contributor2.collective.slug);
    });

    it('filters by ADMIN relation', async () => {
      const result = await graphqlQueryV2(
        communityQuery,
        {
          host: { legacyId: host.id },
          account: { legacyId: collective.id },
          relation: ['ADMIN'],
          limit: 100,
          offset: 0,
        },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const { community } = result.data;
      const slugs = community.nodes.map(n => n.slug);
      expect(slugs).to.include(expenseSubmitter.collective.slug);
    });
  });

  describe('searchTerm', () => {
    it('searches by name', async () => {
      const result = await graphqlQueryV2(
        communityQuery,
        {
          host: { legacyId: host.id },
          searchTerm: 'Alice',
          limit: 100,
          offset: 0,
        },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const { community } = result.data;
      expect(community.totalCount).to.equal(1);
      expect(community.nodes[0].slug).to.equal(contributor1.collective.slug);
    });

    it('searches by slug', async () => {
      const result = await graphqlQueryV2(
        communityQuery,
        {
          host: { legacyId: host.id },
          searchTerm: `@${contributor2.collective.slug}`,
          limit: 100,
          offset: 0,
        },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const { community } = result.data;
      expect(community.totalCount).to.equal(1);
      expect(community.nodes[0].slug).to.equal(contributor2.collective.slug);
    });

    it('searches by id', async () => {
      const result = await graphqlQueryV2(
        communityQuery,
        {
          host: { legacyId: host.id },
          searchTerm: `#${collective.id}`,
          limit: 100,
          offset: 0,
        },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const { community } = result.data;
      expect(community.totalCount).to.be.greaterThan(0);
    });
  });

  describe('totalContributed filter', () => {
    it('filters by minimum total contributed', async () => {
      const result = await graphqlQueryV2(
        communityQuery,
        {
          host: { legacyId: host.id },
          totalContributed: { gte: { valueInCents: 200000, currency: 'USD' } },
          limit: 100,
          offset: 0,
        },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const { community } = result.data;
      const slugs = community.nodes.map(n => n.slug);
      // contributor1 contributed $5000 (500000 cents) which is >= $2000, contributor2 only $1000 which is not
      expect(slugs).to.include(contributor1.collective.slug);
      expect(slugs).to.not.include(contributor2.collective.slug);
    });

    it('filters by maximum total contributed', async () => {
      const result = await graphqlQueryV2(
        communityQuery,
        {
          host: { legacyId: host.id },
          totalContributed: { lte: { valueInCents: 200000, currency: 'USD' } },
          limit: 100,
          offset: 0,
        },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const { community } = result.data;
      const slugs = community.nodes.map(n => n.slug);
      // Only contributor2 contributed $1000 which is <= $2000
      expect(slugs).to.include(contributor2.collective.slug);
      expect(slugs).to.not.include(contributor1.collective.slug);
    });
  });

  describe('totalExpended filter', () => {
    it('filters by minimum total expended', async () => {
      const result = await graphqlQueryV2(
        communityQuery,
        {
          host: { legacyId: host.id },
          totalExpended: { gte: { valueInCents: 100000, currency: 'USD' } },
          limit: 100,
          offset: 0,
        },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const { community } = result.data;
      const slugs = community.nodes.map(n => n.slug);
      // expenseSubmitter had $2000 in expenses
      expect(slugs).to.include(expenseSubmitter.collective.slug);
    });
  });

  describe('pagination', () => {
    it('respects limit and offset', async () => {
      const result1 = await graphqlQueryV2(
        communityQuery,
        { host: { legacyId: host.id }, limit: 1, offset: 0 },
        hostAdmin,
      );
      expect(result1.errors).to.not.exist;
      expect(result1.data.community.nodes).to.have.length(1);
      expect(result1.data.community.limit).to.equal(1);
      expect(result1.data.community.offset).to.equal(0);

      const result2 = await graphqlQueryV2(
        communityQuery,
        { host: { legacyId: host.id }, limit: 1, offset: 1 },
        hostAdmin,
      );
      expect(result2.errors).to.not.exist;
      expect(result2.data.community.nodes).to.have.length(1);
      expect(result2.data.community.offset).to.equal(1);

      // The two pages should return different accounts
      expect(result1.data.community.nodes[0].id).to.not.equal(result2.data.community.nodes[0].id);
    });
  });

  describe('orderBy', () => {
    it('orders by NAME ascending', async () => {
      const result = await graphqlQueryV2(
        communityQuery,
        {
          host: { legacyId: host.id },
          account: { legacyId: collective.id },
          orderBy: { field: 'NAME', direction: 'ASC' },
          limit: 100,
          offset: 0,
        },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const names = result.data.community.nodes.map(n => n.name);
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      expect(names).to.deep.equal(sorted);
    });

    it('orders by TOTAL_CONTRIBUTED descending', async () => {
      const result = await graphqlQueryV2(
        communityQuery,
        {
          host: { legacyId: host.id },
          account: { legacyId: collective.id },
          orderBy: { field: 'TOTAL_CONTRIBUTED', direction: 'DESC' },
          limit: 100,
          offset: 0,
        },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const { community } = result.data;
      expect(community.nodes.length).to.be.greaterThan(0);
      // contributor1 ($5000) should come before contributor2 ($1000) when ordered by total contributed DESC
      const slugs = community.nodes.map(n => n.slug);
      const idx1 = slugs.indexOf(contributor1.collective.slug);
      const idx2 = slugs.indexOf(contributor2.collective.slug);
      if (idx1 !== -1 && idx2 !== -1) {
        expect(idx1).to.be.lessThan(idx2);
      }
    });

    it('orders by CREATED_AT', async () => {
      const result = await graphqlQueryV2(
        communityQuery,
        {
          host: { legacyId: host.id },
          orderBy: { field: 'CREATED_AT', direction: 'DESC' },
          limit: 100,
          offset: 0,
        },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.community.nodes.length).to.be.greaterThan(0);
    });
  });

  describe('community list snapshot', () => {
    const snapshotCommunityQuery = gql`
      query CommunitySnapshot($host: AccountReferenceInput!, $limit: Int!, $offset: Int!) {
        community(host: $host, limit: $limit, offset: $offset) {
          totalCount
          nodes {
            name
            type
            isIncognito
            ... on Individual {
              isGuest
            }
            communityStats(host: $host) {
              relations
              transactionSummary {
                kind
                creditTotal {
                  valueInCents
                  currency
                }
                creditCount
                debitTotal {
                  valueInCents
                  currency
                }
                debitCount
              }
            }
          }
        }
      }
    `;

    let snapshotHost, snapshotHostAdmin, snapshotCollective;

    before(async () => {
      // 1. Host Admin (snapshotHostAdmin) — already set up via fakeActiveHost
      snapshotHostAdmin = await fakeUser({}, { name: 'Snapshot Host Admin' });
      snapshotHost = await fakeActiveHost({ admin: snapshotHostAdmin });
      snapshotCollective = await fakeCollective({ HostCollectiveId: snapshotHost.id });

      // 2. Collective Admin
      const collectiveAdmin = await fakeUser({}, { name: 'Collective Admin' });
      await fakeMember({
        CollectiveId: snapshotCollective.id,
        MemberCollectiveId: collectiveAdmin.CollectiveId,
        role: MemberRoles.ADMIN,
      });

      // 3. Contributor to Collective with order and expense
      const contributorWithOrderAndExpense = await fakeUser({}, { name: 'Contributor Order And Expense' });
      await fakeMember({
        CollectiveId: snapshotCollective.id,
        MemberCollectiveId: contributorWithOrderAndExpense.CollectiveId,
        role: MemberRoles.BACKER,
      });
      const tg1 = uuid();
      await fakeTransaction({
        type: 'CREDIT',
        kind: TransactionKind.CONTRIBUTION,
        FromCollectiveId: contributorWithOrderAndExpense.CollectiveId,
        CollectiveId: snapshotCollective.id,
        HostCollectiveId: snapshotHost.id,
        amount: 10000,
        currency: 'USD',
        hostCurrency: 'USD',
        TransactionGroup: tg1,
      });
      await fakeTransaction({
        type: 'DEBIT',
        kind: TransactionKind.CONTRIBUTION,
        FromCollectiveId: snapshotCollective.id,
        CollectiveId: contributorWithOrderAndExpense.CollectiveId,
        HostCollectiveId: snapshotHost.id,
        amount: -10000,
        currency: 'USD',
        hostCurrency: 'USD',
        TransactionGroup: tg1,
      });
      const tg2 = uuid();
      await fakeTransaction({
        type: 'DEBIT',
        kind: TransactionKind.EXPENSE,
        FromCollectiveId: contributorWithOrderAndExpense.CollectiveId,
        CollectiveId: snapshotCollective.id,
        HostCollectiveId: snapshotHost.id,
        amount: -5000,
        currency: 'USD',
        hostCurrency: 'USD',
        TransactionGroup: tg2,
      });
      await fakeTransaction({
        type: 'CREDIT',
        kind: TransactionKind.EXPENSE,
        FromCollectiveId: snapshotCollective.id,
        CollectiveId: contributorWithOrderAndExpense.CollectiveId,
        HostCollectiveId: snapshotHost.id,
        amount: 5000,
        currency: 'USD',
        hostCurrency: 'USD',
        TransactionGroup: tg2,
      });
      await fakeActivity({
        type: 'collective.expense.created',
        FromCollectiveId: contributorWithOrderAndExpense.CollectiveId,
        CollectiveId: snapshotCollective.id,
        HostCollectiveId: snapshotHost.id,
      });
      await fakeActivity({
        type: 'collective.expense.paid',
        FromCollectiveId: contributorWithOrderAndExpense.CollectiveId,
        CollectiveId: snapshotCollective.id,
        HostCollectiveId: snapshotHost.id,
      });

      // 4. Contributor to Host with order and expense
      const hostContributorWithOrderAndExpense = await fakeUser({}, { name: 'Host Contributor Order And Expense' });
      await fakeMember({
        CollectiveId: snapshotHost.id,
        MemberCollectiveId: hostContributorWithOrderAndExpense.CollectiveId,
        role: MemberRoles.BACKER,
      });
      const tg3 = uuid();
      await fakeTransaction({
        type: 'CREDIT',
        kind: TransactionKind.CONTRIBUTION,
        FromCollectiveId: hostContributorWithOrderAndExpense.CollectiveId,
        CollectiveId: snapshotHost.id,
        HostCollectiveId: snapshotHost.id,
        amount: 10000,
        currency: 'USD',
        hostCurrency: 'USD',
        TransactionGroup: tg3,
      });
      await fakeTransaction({
        type: 'DEBIT',
        kind: TransactionKind.CONTRIBUTION,
        FromCollectiveId: snapshotHost.id,
        CollectiveId: hostContributorWithOrderAndExpense.CollectiveId,
        HostCollectiveId: snapshotHost.id,
        amount: -10000,
        currency: 'USD',
        hostCurrency: 'USD',
        TransactionGroup: tg3,
      });
      const tg4 = uuid();
      await fakeTransaction({
        type: 'DEBIT',
        kind: TransactionKind.EXPENSE,
        FromCollectiveId: hostContributorWithOrderAndExpense.CollectiveId,
        CollectiveId: snapshotHost.id,
        HostCollectiveId: snapshotHost.id,
        amount: -5000,
        currency: 'USD',
        hostCurrency: 'USD',
        TransactionGroup: tg4,
      });
      await fakeTransaction({
        type: 'CREDIT',
        kind: TransactionKind.EXPENSE,
        FromCollectiveId: snapshotHost.id,
        CollectiveId: hostContributorWithOrderAndExpense.CollectiveId,
        HostCollectiveId: snapshotHost.id,
        amount: 5000,
        currency: 'USD',
        hostCurrency: 'USD',
        TransactionGroup: tg4,
      });
      await fakeActivity({
        type: 'collective.expense.created',
        FromCollectiveId: hostContributorWithOrderAndExpense.CollectiveId,
        CollectiveId: snapshotHost.id,
        HostCollectiveId: snapshotHost.id,
      });
      await fakeActivity({
        type: 'collective.expense.paid',
        FromCollectiveId: hostContributorWithOrderAndExpense.CollectiveId,
        CollectiveId: snapshotHost.id,
        HostCollectiveId: snapshotHost.id,
      });

      // 5. Guest contributor to collective
      const guestUser = await fakeUser(
        {},
        {
          name: 'Guest Contributor',
          slug: randStr('guest'),
          data: { isGuest: true, requiresProfileCompletion: true },
        },
      );
      const guestCollective = guestUser.collective;
      await fakeMember({
        CollectiveId: snapshotCollective.id,
        MemberCollectiveId: guestCollective.id,
        role: MemberRoles.BACKER,
      });
      const tg5 = uuid();
      await fakeTransaction({
        type: 'CREDIT',
        kind: TransactionKind.CONTRIBUTION,
        FromCollectiveId: guestCollective.id,
        CollectiveId: snapshotCollective.id,
        HostCollectiveId: snapshotHost.id,
        amount: 5000,
        currency: 'USD',
        hostCurrency: 'USD',
        TransactionGroup: tg5,
      });
      await fakeTransaction({
        type: 'DEBIT',
        kind: TransactionKind.CONTRIBUTION,
        FromCollectiveId: snapshotCollective.id,
        CollectiveId: guestCollective.id,
        HostCollectiveId: snapshotHost.id,
        amount: -5000,
        currency: 'USD',
        hostCurrency: 'USD',
        TransactionGroup: tg5,
      });

      // 6. Contributor to Collective with incognito order
      const incognitoUser = await fakeUser({}, { name: 'Real Contributor User' });
      const incognitoProfile = await fakeIncognitoProfile(incognitoUser);
      await fakeMember({
        CollectiveId: snapshotCollective.id,
        MemberCollectiveId: incognitoProfile.id,
        role: MemberRoles.BACKER,
      });
      const tg6 = uuid();
      await fakeTransaction({
        type: 'CREDIT',
        kind: TransactionKind.CONTRIBUTION,
        FromCollectiveId: incognitoProfile.id,
        CollectiveId: snapshotCollective.id,
        HostCollectiveId: snapshotHost.id,
        amount: 5000,
        currency: 'USD',
        hostCurrency: 'USD',
        TransactionGroup: tg6,
      });
      await fakeTransaction({
        type: 'DEBIT',
        kind: TransactionKind.CONTRIBUTION,
        FromCollectiveId: snapshotCollective.id,
        CollectiveId: incognitoProfile.id,
        HostCollectiveId: snapshotHost.id,
        amount: -5000,
        currency: 'USD',
        hostCurrency: 'USD',
        TransactionGroup: tg6,
      });

      await refreshCommunityMaterializedViews();
    });

    it('snapshot: community list includes all expected user types', async () => {
      const result = await graphqlQueryV2(
        snapshotCommunityQuery,
        { host: { legacyId: snapshotHost.id }, limit: 100, offset: 0 },
        snapshotHostAdmin,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const community = result.data.community.nodes
        .map(n => ({
          name: n.name,
          type: n.type,
          isIncognito: n.isIncognito,
          isGuest: n.isGuest,
          relations: [...n.communityStats.relations].sort(),
          transactionSummary: n.communityStats.transactionSummary
            .map(s => ({
              kind: s.kind,
              creditTotal: s.creditTotal,
              creditCount: s.creditCount,
              debitTotal: s.debitTotal,
              debitCount: s.debitCount,
            }))
            .sort((a, b) => String(a.kind).localeCompare(String(b.kind))),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      expect(community).to.matchSnapshot();
    });
  });

  describe('account not hosted by host', () => {
    it('rejects when account is not hosted by the given host', async () => {
      const otherHost = await fakeActiveHost();
      const otherCollective = await fakeCollective({ HostCollectiveId: otherHost.id });
      const result = await graphqlQueryV2(
        communityQuery,
        {
          host: { legacyId: host.id },
          account: { legacyId: otherCollective.id },
          limit: 10,
          offset: 0,
        },
        hostAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('not hosted by the host provided');
    });
  });
});
