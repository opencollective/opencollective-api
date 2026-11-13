import { expect } from 'chai';
import gql from 'fake-tag';
import sinon from 'sinon';
import { v4 as uuid } from 'uuid';

import MemberRoles from '../../../../../server/constants/roles';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import * as CommunitySearchLib from '../../../../../server/lib/community-search';
import models, { sequelize } from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeActivity,
  fakeCollective,
  fakeIncognitoProfile,
  fakeMember,
  fakeOrganization,
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
  await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityActivitySummary"');
  await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityTransactionSummary"');
  await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityHostYearlyTransactionSummary"');
  await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityHostTransactionSummary"');
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

  describe('searchTerm (matching accounts first and regular conditions)', () => {
    let sandbox, searchHost, searchHostAdmin, searchCollective, otherCollective, collectiveAdmin;
    let aaron, betty, carla, dora, eve, gina, hank, ivy, zeppelinOrg;

    /** A person of the community, with nothing random in the searched fields */
    const fakePerson = async (
      name: string,
      emailPrefix: string,
      role = MemberRoles.BACKER,
      account = searchCollective,
    ) => {
      const slug = `${name.toLowerCase().replace(/[^a-z]+/g, '-')}-person`;
      const user = await fakeUser({ email: `${emailPrefix}@community-search.test` }, { name, slug });
      await fakeMember({ CollectiveId: account.id, MemberCollectiveId: user.CollectiveId, role });
      return user;
    };

    /**
     * Runs the search with the matching accounts resolved first, then with the regular conditions, and expects the
     * same accounts in the same order (by name) and the same total from both. `accountsFirst: false` is for the
     * searches that only use the regular conditions.
     */
    const expectSearchResults = async (
      variables: Record<string, unknown>,
      expectedPeople,
      { accountsFirst = true, totalCount = expectedPeople.length, remoteUser = searchHostAdmin } = {},
    ) => {
      const search = async () => {
        const result = await graphqlQueryV2(
          communityQuery,
          {
            host: { legacyId: searchHost.id },
            orderBy: { field: 'NAME', direction: 'ASC' },
            limit: 100,
            offset: 0,
            ...variables,
          },
          remoteUser,
        );
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.community.nodes.map(node => node.name)).to.deep.eq(
          expectedPeople.map(person => (person.collective || person).name),
        );
        expect(result.data.community.totalCount).to.eq(totalCount);
      };

      const findAccountIds = sandbox.spy(CommunitySearchLib, 'findCommunitySearchAccountIds');
      await search();
      const accountIds = findAccountIds.called ? await findAccountIds.lastCall.returnValue : null;
      findAccountIds.restore();
      expect(Boolean(accountIds)).to.eq(accountsFirst);

      const withRegularConditions = sandbox.stub(CommunitySearchLib, 'findCommunitySearchAccountIds').resolves(null);
      await search();
      withRegularConditions.restore();
      return accountIds;
    };

    before(async () => {
      sandbox = sinon.createSandbox();
      searchHostAdmin = await fakeUser(
        { email: 'host.admin@community-search.test' },
        { name: 'Search Host Admin', slug: 'search-host-admin' },
      );
      searchHost = await fakeActiveHost({ admin: searchHostAdmin, name: 'Search Host', slug: 'search-host' });
      searchCollective = await fakeCollective({ HostCollectiveId: searchHost.id, name: 'Searched', slug: 'searched' });
      otherCollective = await fakeCollective({ HostCollectiveId: searchHost.id, name: 'Other', slug: 'other' });

      aaron = await fakePerson('Aaron Zeppelinsky', 'aaron');
      betty = await fakePerson('Betty Plain', 'betty');
      await betty.collective.update({ slug: 'betty-slugonlymatch' });
      carla = await fakePerson('Carla Plain', 'carla.mailonlymatch');
      dora = await fakePerson('Dora Plain', 'dora.zeppelin');
      eve = await fakePerson('Eve Deletedusermatch', 'eve.deletedusermatch');
      const frank = await fakePerson('Frank Deletedaccountmatch', 'frank.deletedaccountmatch');
      gina = await fakePerson('Gina Zeppelinadmin', 'gina', MemberRoles.ADMIN);
      hank = await fakePerson('Hank Zeppelinother', 'hank', MemberRoles.BACKER, otherCollective);
      ivy = await fakePerson('Ivy 100% Legit', 'ivy_underscore');
      collectiveAdmin = gina;
      zeppelinOrg = await fakeOrganization({ name: 'Zeppelin Org', slug: 'zeppelin-org' });
      await fakeMember({
        CollectiveId: searchCollective.id,
        MemberCollectiveId: zeppelinOrg.id,
        role: MemberRoles.BACKER,
      });

      // Same name in the community of another host: found by the account lookup, never returned
      const elsewhere = await fakeCollective({ HostCollectiveId: (await fakeActiveHost()).id });
      await fakePerson('Zach Zeppelinelsewhere', 'zach', MemberRoles.BACKER, elsewhere);

      await refreshCommunityMaterializedViews();

      // Deleted after the refresh: they both keep their row in the summary, and what made them match
      await eve.destroy();
      await frank.collective.destroy();
    });

    beforeEach(() => {
      // Fixtures have a handful of rows: far below the size from which matching accounts are resolved first
      sandbox.stub(CommunitySearchLib.COMMUNITY_SEARCH_LIMITS, 'minScopeRows').value(1);
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('searches by name', async () => {
      await expectSearchResults({ searchTerm: 'Zeppelinsky' }, [aaron]);
      await expectSearchResults({ searchTerm: 'zEpPeLiNsKy' }, [aaron]);
      await expectSearchResults({ searchTerm: 'Aaron Zeppelinsky' }, [aaron]);
      await expectSearchResults({ searchTerm: '  Plain ' }, [betty, carla, dora]);
    });

    it('searches by slug', async () => {
      await expectSearchResults({ searchTerm: 'slugonlymatch' }, [betty]);
      // `@slug` only looks at the slug, with the regular conditions
      await expectSearchResults({ searchTerm: '@betty-slugonlymatch' }, [betty], { accountsFirst: false });
      await expectSearchResults({ searchTerm: '@zeppelinsky' }, [aaron], { accountsFirst: false });
    });

    it('searches by email', async () => {
      await expectSearchResults({ searchTerm: 'mailonlymatch' }, [carla]);
      await expectSearchResults({ searchTerm: 'MAILONLYMATCH@community-search' }, [carla]);
      // A full email address is an exact match, with the regular conditions
      await expectSearchResults({ searchTerm: 'carla.mailonlymatch@community-search.test' }, [carla], {
        accountsFirst: false,
      });
      await expectSearchResults({ searchTerm: 'mailonlymatch@community-search.test' }, [], { accountsFirst: false });
    });

    it('does not search for viewers who are not admins of the host, with either conditions', async () => {
      for (const resolvedIds of [undefined, null]) {
        const findAccountIds =
          resolvedIds === null
            ? sandbox.stub(CommunitySearchLib, 'findCommunitySearchAccountIds').resolves(null)
            : sandbox.spy(CommunitySearchLib, 'findCommunitySearchAccountIds');
        for (const remoteUser of [collectiveAdmin, aaron, undefined]) {
          const result = await graphqlQueryV2(
            communityQuery,
            { host: { legacyId: searchHost.id }, searchTerm: 'mailonlymatch', limit: 100, offset: 0 },
            remoteUser,
          );
          expect(result.errors).to.exist;
          expect(result.data).to.not.exist;
        }
        expect(findAccountIds.called).to.be.false;
        findAccountIds.restore();
      }
    });

    it('returns the accounts matching by name, by slug or by the email of their user', async () => {
      // Aaron and Gina by name (and slug), Dora by email, Hank through another hosted collective, the organization
      const everyone = [aaron, dora, gina, hank, zeppelinOrg];
      const accountIds = await expectSearchResults({ searchTerm: 'zeppelin' }, everyone);
      // Looked up on the whole platform: one more account, from another host
      expect(accountIds).to.have.length(everyone.length + 1);
      expect(accountIds).to.include.members(everyone.map(person => person.CollectiveId || person.id));
    });

    it('combines with the other filters', async () => {
      await expectSearchResults({ searchTerm: 'zeppelin', type: ['INDIVIDUAL'] }, [aaron, dora, gina, hank]);
      await expectSearchResults({ searchTerm: 'zeppelin', type: ['ORGANIZATION'] }, [zeppelinOrg]);
      await expectSearchResults({ searchTerm: 'zeppelin', relation: ['ADMIN'] }, [gina]);
      await expectSearchResults({ searchTerm: 'zeppelin', relation: ['CONTRIBUTOR'] }, [
        aaron,
        dora,
        hank,
        zeppelinOrg,
      ]);
      await expectSearchResults({ searchTerm: 'zeppelin', relation: ['ADMIN', 'CONTRIBUTOR'] }, []);
      await expectSearchResults({ searchTerm: 'zeppelin', account: { legacyId: otherCollective.id } }, [hank]);
      await expectSearchResults({ searchTerm: 'zeppelin', account: { legacyId: searchCollective.id } }, [
        aaron,
        dora,
        gina,
        zeppelinOrg,
      ]);
      await expectSearchResults(
        { searchTerm: 'zeppelin', totalContributed: { gte: { valueInCents: 1, currency: 'USD' } } },
        [],
      );
    });

    it('paginates and sorts', async () => {
      const options = { totalCount: 5 };
      await expectSearchResults({ searchTerm: 'zeppelin', limit: 2 }, [aaron, dora], options);
      await expectSearchResults({ searchTerm: 'zeppelin', limit: 2, offset: 2 }, [gina, hank], options);
      await expectSearchResults({ searchTerm: 'zeppelin', limit: 2, offset: 4 }, [zeppelinOrg], options);
      await expectSearchResults({ searchTerm: 'zeppelin', limit: 2, offset: 6 }, [], options);
      // Most recent accounts first
      await expectSearchResults(
        { searchTerm: 'zeppelin', limit: 3, orderBy: { field: 'CREATED_AT', direction: 'DESC' } },
        [zeppelinOrg, hank, gina],
        options,
      );
      await expectSearchResults(
        { searchTerm: 'zeppelin', limit: 3, offset: 3, orderBy: { field: 'CREATED_AT', direction: 'DESC' } },
        [dora, aaron],
        options,
      );
    });

    it('returns nothing when nothing matches', async () => {
      const accountIds = await expectSearchResults({ searchTerm: 'nobodyhasthisname' }, []);
      expect(accountIds).to.deep.eq([]);
    });

    it('ignores deleted users and deleted accounts', async () => {
      // Eve's user is deleted: she does not match by email anymore, her account still matches by name
      await expectSearchResults({ searchTerm: 'eve.deletedusermatch' }, []);
      await expectSearchResults({ searchTerm: 'Eve Deletedusermatch' }, [eve]);
      // Frank's account is deleted: it matches neither by name nor by the email of its user
      await expectSearchResults({ searchTerm: 'Frank Deletedaccountmatch' }, []);
      await expectSearchResults({ searchTerm: 'frank.deletedaccountmatch' }, []);
    });

    it('matches wildcard characters literally', async () => {
      await expectSearchResults({ searchTerm: '100%' }, [ivy]);
      await expectSearchResults({ searchTerm: '1__%' }, [], { accountsFirst: false });
      await expectSearchResults({ searchTerm: 'ivy_underscore' }, [ivy]);
      await expectSearchResults({ searchTerm: 'ivy_undersc_re' }, []);
      await expectSearchResults({ searchTerm: 'Aar_n' }, []);
    });

    it('uses the regular conditions when too many accounts match', async () => {
      // 6 accounts match on the platform, by name or by email
      sandbox.stub(CommunitySearchLib.COMMUNITY_SEARCH_LIMITS, 'maxAccounts').value(5);
      const everyone = [aaron, dora, gina, hank, zeppelinOrg];
      await expectSearchResults({ searchTerm: 'zeppelin' }, everyone, { accountsFirst: false });
      await expectSearchResults({ searchTerm: 'zeppelin', relation: ['ADMIN'] }, [gina], { accountsFirst: false });
      await expectSearchResults({ searchTerm: 'zeppelin', limit: 2, offset: 2 }, [gina, hank], {
        accountsFirst: false,
        totalCount: 5,
      });
      // 4 by name and 2 others by email: each lookup is below the limit, not their union
      await expectSearchResults({ searchTerm: 'zeppelin' }, everyone, { accountsFirst: false });
      // Still used below the limit
      await expectSearchResults({ searchTerm: 'Plain' }, [betty, carla, dora]);
      sandbox.restore();
      sandbox.stub(CommunitySearchLib.COMMUNITY_SEARCH_LIMITS, 'minScopeRows').value(1);
      sandbox.stub(CommunitySearchLib.COMMUNITY_SEARCH_LIMITS, 'maxAccounts').value(6);
      await expectSearchResults({ searchTerm: 'zeppelin' }, everyone);
    });

    it('uses the regular conditions for a term without 3 consecutive letters or digits', async () => {
      const everyone = [aaron, dora, gina, hank, zeppelinOrg];
      await expectSearchResults({ searchTerm: 'ze' }, everyone, { accountsFirst: false });
      await expectSearchResults({ searchTerm: 'zep' }, everyone);
      await expectSearchResults({ searchTerm: '% L' }, [ivy], { accountsFirst: false });
      await expectSearchResults({ searchTerm: '% Le' }, [ivy], { accountsFirst: false });
      await expectSearchResults({ searchTerm: '% Leg' }, [ivy]);
      await expectSearchResults({ searchTerm: 'C++' }, [], { accountsFirst: false });
      await expectSearchResults({ searchTerm: '___' }, [], { accountsFirst: false });
      await expectSearchResults({ searchTerm: 'a-b-c' }, [], { accountsFirst: false });
    });

    it('uses the regular conditions when the host or the account has few rows', async () => {
      sandbox.restore();
      await expectSearchResults({ searchTerm: 'zeppelin', relation: ['ADMIN'] }, [gina], { accountsFirst: false });

      // The host has 11 rows, the other collective has one
      sandbox.stub(CommunitySearchLib.COMMUNITY_SEARCH_LIMITS, 'minScopeRows').value(11);
      await expectSearchResults({ searchTerm: 'zeppelin', relation: ['ADMIN'] }, [gina]);
      await expectSearchResults({ searchTerm: 'zeppelin', account: { legacyId: otherCollective.id } }, [hank], {
        accountsFirst: false,
      });
      sandbox.restore();
      sandbox.stub(CommunitySearchLib.COMMUNITY_SEARCH_LIMITS, 'minScopeRows').value(12);
      await expectSearchResults({ searchTerm: 'zeppelin', relation: ['ADMIN'] }, [gina], { accountsFirst: false });
    });
  });

  describe('order among accounts with the same name or total', () => {
    let sandbox, tiedHost, tiedHostAdmin, twins, abeAndZed, everyoneById;

    /** All the pages of a list, as the IDs of their accounts in the order they were returned */
    const fetchAllPages = async (variables: Record<string, unknown>, limit: number) => {
      const ids = [];
      for (let offset = 0; ; offset += limit) {
        const result = await graphqlQueryV2(
          communityQuery,
          { host: { legacyId: tiedHost.id }, ...variables, limit, offset },
          tiedHostAdmin,
        );
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        ids.push(...result.data.community.nodes.map(node => node.id));
        if (result.data.community.nodes.length < limit) {
          return ids;
        }
      }
    };

    /** Expects every account once across the pages, in this order, with or without the matching accounts first */
    const expectPages = async (variables: Record<string, unknown>, expectedAccounts, { accountsFirst = true } = {}) => {
      const expectedIds = expectedAccounts.map(account => idEncode(account.id, IDENTIFIER_TYPES.ACCOUNT));
      const findAccountIds = sandbox.spy(CommunitySearchLib, 'findCommunitySearchAccountIds');
      expect(await fetchAllPages(variables, 3)).to.deep.eq(expectedIds);
      expect(Boolean(findAccountIds.called && (await findAccountIds.lastCall.returnValue))).to.eq(accountsFirst);
      findAccountIds.restore();

      const withRegularConditions = sandbox.stub(CommunitySearchLib, 'findCommunitySearchAccountIds').resolves(null);
      expect(await fetchAllPages(variables, 3)).to.deep.eq(expectedIds);
      expect(await fetchAllPages(variables, 4)).to.deep.eq(expectedIds);
      withRegularConditions.restore();
    };

    before(async () => {
      sandbox = sinon.createSandbox();
      tiedHostAdmin = await fakeUser({}, { name: 'Zoe Tiedhostadmin' });
      tiedHost = await fakeActiveHost({ admin: tiedHostAdmin });
      const tiedCollective = await fakeCollective({ HostCollectiveId: tiedHost.id });
      const fakeMemberAccount = async (name: string) => {
        const user = await fakeUser({}, { name });
        await fakeMember({
          CollectiveId: tiedCollective.id,
          MemberCollectiveId: user.CollectiveId,
          role: MemberRoles.BACKER,
        });
        return user.collective;
      };

      // Created in an order that is not the one of their names, with no transaction: all tied on their totals
      const zed = await fakeMemberAccount('Zed Alone');
      twins = [];
      for (let i = 0; i < 6; i++) {
        twins.push(await fakeMemberAccount('Tied Twin'));
      }
      const abe = await fakeMemberAccount('Abe Alone');
      for (let i = 0; i < 5; i++) {
        twins.push(await fakeMemberAccount('Tied Twin'));
      }
      abeAndZed = [abe, zed];
      everyoneById = [tiedHostAdmin.collective, zed, ...twins.slice(0, 6), abe, ...twins.slice(6)];
      await refreshCommunityMaterializedViews();
    });

    beforeEach(() => {
      sandbox.stub(CommunitySearchLib.COMMUNITY_SEARCH_LIMITS, 'minScopeRows').value(1);
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('returns each account once across pages, by account id among the same names', async () => {
      const byName = { orderBy: { field: 'NAME', direction: 'ASC' } };
      const everyoneByName = [abeAndZed[0], ...twins, abeAndZed[1], tiedHostAdmin.collective];
      await expectPages({ ...byName, searchTerm: 'Tied Twin' }, twins);
      await expectPages({ ...byName, searchTerm: 'Alone' }, abeAndZed);
      await expectPages(byName, everyoneByName, { accountsFirst: false });
      await expectPages({}, everyoneByName, { accountsFirst: false });
    });

    it('uses the regular conditions when a lookup is cut by its limit, also when users share an account', async () => {
      // Nothing prevents two users from having the same account: 3 users match by email, for 2 accounts
      const [abe] = abeAndZed;
      for (const [name, account] of [
        ['one', twins[0]],
        ['two', twins[0]],
        ['three', abe],
      ]) {
        await models.User.create({ email: `${name}.sharedmailmatch@community-search.test`, CollectiveId: account.id });
      }

      const variables = { orderBy: { field: 'NAME', direction: 'ASC' }, searchTerm: 'sharedmailmatch' };
      for (const maxAccounts of [1, 2]) {
        // The lookup of users stops after `maxAccounts + 1` rows, which can all be for the same account
        const limit = sandbox.stub(CommunitySearchLib.COMMUNITY_SEARCH_LIMITS, 'maxAccounts').value(maxAccounts);
        await expectPages(variables, [abe, twins[0]], { accountsFirst: false });
        limit.restore();
      }

      sandbox.stub(CommunitySearchLib.COMMUNITY_SEARCH_LIMITS, 'maxAccounts').value(3);
      await expectPages(variables, [abe, twins[0]]);
    });

    it('returns each account once across pages, by account id among the same totals', async () => {
      for (const field of ['TOTAL_CONTRIBUTED', 'TOTAL_EXPENDED']) {
        for (const direction of ['ASC', 'DESC']) {
          const orderBy = { field, direction };
          await expectPages({ orderBy, searchTerm: 'Tied Twin' }, twins);
          await expectPages({ orderBy, searchTerm: 'Tied' }, [tiedHostAdmin.collective, ...twins]);
          await expectPages({ orderBy }, everyoneById, { accountsFirst: false });
        }
      }
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
        UserId: contributorWithOrderAndExpense.id,
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
        UserId: hostContributorWithOrderAndExpense.id,
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
      await fakeMember({
        CollectiveId: snapshotCollective.id,
        MemberCollectiveId: incognitoUser.collective.id,
        role: MemberRoles.BACKER,
      });
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
        FromCollectiveId: incognitoUser.collective.id,
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
        CollectiveId: incognitoUser.collective.id,
        HostCollectiveId: snapshotHost.id,
        amount: -5000,
        currency: 'USD',
        hostCurrency: 'USD',
        TransactionGroup: tg6,
      });
      const tg7 = uuid();
      await fakeTransaction({
        type: 'CREDIT',
        kind: TransactionKind.CONTRIBUTION,
        FromCollectiveId: incognitoProfile.id,
        CollectiveId: snapshotCollective.id,
        HostCollectiveId: snapshotHost.id,
        amount: 5000,
        currency: 'USD',
        hostCurrency: 'USD',
        TransactionGroup: tg7,
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
        TransactionGroup: tg7,
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
