import { expect } from 'chai';
import gql from 'fake-tag';
import nock from 'nock';

import MemberRoles from '../../../../../server/constants/roles';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { KYCVerificationStatus } from '../../../../../server/models/KYCVerification';
import {
  fakeActiveHost,
  fakeActivity,
  fakeCollective,
  fakeExpense,
  fakeIncognitoProfile,
  fakeKYCVerification,
  fakeMember,
  fakeOrder,
  fakeOrganization,
  fakePrivateHost,
  fakeProject,
  fakeTier,
  fakeTransaction,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, nockFixerRates, resetCaches, resetTestDB } from '../../../../utils';

describe('server/graphql/v2/interface/Account', () => {
  describe('kycVerificationRequests', () => {
    const query = gql`
      query KYCVerificationRequestsTest(
        $slug: String!
        $limit: Int
        $offset: Int
        $accounts: [AccountReferenceInput!]
      ) {
        account(slug: $slug) {
          kycVerificationRequests(limit: $limit, offset: $offset, accounts: $accounts) {
            limit
            offset
            totalCount

            nodes {
              status
            }
          }
        }
      }
    `;

    beforeEach(async () => {
      await resetTestDB();
    });
    it('returns error if user is not authenticated', async () => {
      const org = await fakeOrganization();

      const result = await graphqlQueryV2(query, { slug: org.slug });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage KYC.');
    });

    it('returns error if user is not organization admin', async () => {
      const other = await fakeUser();
      const org = await fakeOrganization();

      const result = await graphqlQueryV2(query, { slug: org.slug }, other);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You are authenticated but forbidden to perform this action');
    });

    it('returns kyc verification request made by org', async () => {
      const admin = await fakeUser();
      const org = await fakeOrganization({ admin });

      let result = await graphqlQueryV2(query, { slug: org.slug }, admin);
      expect(result.errors).to.not.exist;
      expect(result.data.account.kycVerificationRequests.totalCount).to.eql(0);

      await fakeKYCVerification({
        RequestedByCollectiveId: org.id,
      });

      await fakeKYCVerification({
        RequestedByCollectiveId: org.id,
      });

      result = await graphqlQueryV2(query, { slug: org.slug }, admin);
      expect(result.errors).to.not.exist;
      expect(result.data.account.kycVerificationRequests.totalCount).to.eql(2);
    });

    it('filters kyc verification request made by org to specific users', async () => {
      const admin = await fakeUser();
      const org = await fakeOrganization({ admin });

      const user1 = await fakeUser();
      const user2 = await fakeUser();
      const unrelatedUser = await fakeUser();

      await fakeKYCVerification({
        RequestedByCollectiveId: org.id,
        CollectiveId: user1.CollectiveId,
        status: KYCVerificationStatus.REVOKED,
      });

      await fakeKYCVerification({
        RequestedByCollectiveId: org.id,
        CollectiveId: user1.CollectiveId,
        status: KYCVerificationStatus.FAILED,
      });

      await fakeKYCVerification({
        RequestedByCollectiveId: org.id,
        CollectiveId: user1.CollectiveId,
        status: KYCVerificationStatus.VERIFIED,
      });

      await fakeKYCVerification({
        RequestedByCollectiveId: org.id,
        CollectiveId: user2.CollectiveId,
      });

      let result = await graphqlQueryV2(query, { slug: org.slug }, admin);
      expect(result.errors).to.not.exist;
      expect(result.data.account.kycVerificationRequests.totalCount).to.eql(4);

      result = await graphqlQueryV2(
        query,
        { slug: org.slug, accounts: [{ slug: unrelatedUser.collective.slug }] },
        admin,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.account.kycVerificationRequests.totalCount).to.eql(0);

      result = await graphqlQueryV2(query, { slug: org.slug, accounts: [{ slug: user1.collective.slug }] }, admin);
      expect(result.errors).to.not.exist;
      expect(result.data.account.kycVerificationRequests.totalCount).to.eql(3);

      result = await graphqlQueryV2(query, { slug: org.slug, accounts: [{ slug: user2.collective.slug }] }, admin);
      expect(result.errors).to.not.exist;
      expect(result.data.account.kycVerificationRequests.totalCount).to.eql(1);

      result = await graphqlQueryV2(
        query,
        { slug: org.slug, accounts: [{ slug: user1.collective.slug }, { slug: user2.collective.slug }] },
        admin,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.account.kycVerificationRequests.totalCount).to.eql(4);
    });

    it('does not return kyc verification requests by other org', async () => {
      const admin = await fakeUser();
      const org = await fakeOrganization({ admin });
      const otherOrgAdmin = await fakeUser();
      const otherOrg = await fakeOrganization({ admin: otherOrgAdmin });

      const user1 = await fakeUser();

      await fakeKYCVerification({
        RequestedByCollectiveId: org.id,
        CollectiveId: user1.CollectiveId,
        status: KYCVerificationStatus.REVOKED,
      });

      let result = await graphqlQueryV2(query, { slug: org.slug }, admin);
      expect(result.errors).to.not.exist;
      expect(result.data.account.kycVerificationRequests.totalCount).to.eql(1);

      result = await graphqlQueryV2(query, { slug: otherOrg.slug }, otherOrgAdmin);
      expect(result.errors).to.not.exist;
      expect(result.data.account.kycVerificationRequests.totalCount).to.eql(0);
    });
  });

  describe('mainProfile', () => {
    const query = gql`
      query MainProfileTest($slug: String!) {
        account(slug: $slug) {
          slug
          isIncognito
          mainProfile {
            slug
          }
        }
      }
    `;

    it('returns null for non-incognito accounts', async () => {
      const user = await fakeUser();
      const result = await graphqlQueryV2(query, { slug: user.collective.slug }, user);
      expect(result.errors).to.not.exist;
      expect(result.data.account.isIncognito).to.be.false;
      expect(result.data.account.mainProfile).to.be.null;
    });

    it('returns null when not authenticated', async () => {
      const user = await fakeUser();
      const incognito = await fakeIncognitoProfile(user);
      const result = await graphqlQueryV2(query, { slug: incognito.slug });
      expect(result.errors).to.not.exist;
      expect(result.data.account.mainProfile).to.be.null;
    });

    it('returns null for an unrelated user', async () => {
      const user = await fakeUser();
      const incognito = await fakeIncognitoProfile(user);
      const otherUser = await fakeUser();
      const result = await graphqlQueryV2(query, { slug: incognito.slug }, otherUser);
      expect(result.errors).to.not.exist;
      expect(result.data.account.mainProfile).to.be.null;
    });

    it('returns the main profile for the account owner', async () => {
      const user = await fakeUser();
      const incognito = await fakeIncognitoProfile(user);
      const result = await graphqlQueryV2(query, { slug: incognito.slug }, user);
      expect(result.errors).to.not.exist;
      expect(result.data.account.isIncognito).to.be.true;
      expect(result.data.account.mainProfile).to.exist;
      expect(result.data.account.mainProfile.slug).to.equal(user.collective.slug);
    });

    it('returns null for an admin of a fiscal host the user never contributed to', async () => {
      const user = await fakeUser();
      const incognito = await fakeIncognitoProfile(user);
      const hostAdmin = await fakeUser();
      await fakeActiveHost({ admin: hostAdmin });
      const result = await graphqlQueryV2(query, { slug: incognito.slug }, hostAdmin);
      expect(result.errors).to.not.exist;
      expect(result.data.account.mainProfile).to.be.null;
    });

    it('returns null for an admin of a collective who received an incognito contribution', async () => {
      const user = await fakeUser();
      const incognito = await fakeIncognitoProfile(user);
      const collectiveAdmin = await fakeUser();
      const collective = await fakeCollective({ admin: collectiveAdmin });
      // Simulate a contribution from the incognito profile to the collective
      await fakeMember({ CollectiveId: collective.id, MemberCollectiveId: incognito.id, role: MemberRoles.BACKER });
      const result = await graphqlQueryV2(query, { slug: incognito.slug }, collectiveAdmin);
      expect(result.errors).to.not.exist;
      expect(result.data.account.isIncognito).to.be.true;
      expect(result.data.account.mainProfile).to.be.null;
    });

    it('returns the main profile for an admin of a fiscal host the user contributed to', async () => {
      const user = await fakeUser();
      const incognito = await fakeIncognitoProfile(user);
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdmin });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      // Simulate a contribution from the incognito profile to the hosted collective
      await fakeMember({ CollectiveId: collective.id, MemberCollectiveId: incognito.id, role: MemberRoles.BACKER });
      const result = await graphqlQueryV2(query, { slug: incognito.slug }, hostAdmin);
      expect(result.errors).to.not.exist;
      expect(result.data.account.isIncognito).to.be.true;
      expect(result.data.account.mainProfile).to.exist;
      expect(result.data.account.mainProfile.slug).to.equal(user.collective.slug);
    });
  });

  describe('taxableCountry', () => {
    const query = gql`
      query TaxableCountryTest($slug: String!) {
        account(slug: $slug) {
          taxableCountry
        }
      }
    `;

    it('returns null when not authenticated', async () => {
      const user = await fakeUser();
      await user.collective.update({ data: { taxableCountry: 'US' } });
      const result = await graphqlQueryV2(query, { slug: user.collective.slug });
      expect(result.errors).to.not.exist;
      expect(result.data.account.taxableCountry).to.be.null;
    });

    it('returns null when the taxableCountry is not set', async () => {
      const user = await fakeUser();
      const result = await graphqlQueryV2(query, { slug: user.collective.slug }, user);
      expect(result.errors).to.not.exist;
      expect(result.data.account.taxableCountry).to.be.null;
    });

    it('returns the taxableCountry for the account owner', async () => {
      const user = await fakeUser();
      await user.collective.update({ data: { taxableCountry: 'US' } });
      const result = await graphqlQueryV2(query, { slug: user.collective.slug }, user);
      expect(result.errors).to.not.exist;
      expect(result.data.account.taxableCountry).to.equal('US');
    });

    it('returns null for an unrelated user', async () => {
      const user = await fakeUser();
      await user.collective.update({ data: { taxableCountry: 'US' } });
      const otherUser = await fakeUser();
      const result = await graphqlQueryV2(query, { slug: user.collective.slug }, otherUser);
      expect(result.errors).to.not.exist;
      expect(result.data.account.taxableCountry).to.be.null;
    });

    it('returns the taxableCountry of the main profile for an incognito account', async () => {
      const user = await fakeUser();
      await user.collective.update({ data: { taxableCountry: 'FR' } });
      const incognito = await fakeIncognitoProfile(user);
      const result = await graphqlQueryV2(query, { slug: incognito.slug }, user);
      expect(result.errors).to.not.exist;
      expect(result.data.account.taxableCountry).to.equal('FR');
    });

    it('does not expose the taxableCountry of a money-management account to anonymous users', async () => {
      // `canSeeLegalName` is public for money-management accounts (host legal names are
      // public), but tax-profile data must not inherit that exemption.
      const host = await fakeActiveHost();
      await host.update({ data: { taxableCountry: 'US' } });
      const result = await graphqlQueryV2(query, { slug: host.slug });
      expect(result.errors).to.not.exist;
      expect(result.data.account.taxableCountry).to.be.null;
    });

    it('does not expose the taxableCountry of a money-management account to an unrelated user', async () => {
      const host = await fakeActiveHost();
      await host.update({ data: { taxableCountry: 'US' } });
      const otherUser = await fakeUser();
      const result = await graphqlQueryV2(query, { slug: host.slug }, otherUser);
      expect(result.errors).to.not.exist;
      expect(result.data.account.taxableCountry).to.be.null;
    });
  });

  describe('isUSEntity', () => {
    const query = gql`
      query IsUSEntityTest($slug: String!) {
        account(slug: $slug) {
          isUSEntity
        }
      }
    `;

    it('returns the isUSEntity for the account owner', async () => {
      const user = await fakeUser();
      await user.collective.update({ data: { isUSEntity: true } });
      const result = await graphqlQueryV2(query, { slug: user.collective.slug }, user);
      expect(result.errors).to.not.exist;
      expect(result.data.account.isUSEntity).to.be.true;
    });

    it('does not expose the isUSEntity of a money-management account to anonymous users', async () => {
      const host = await fakeActiveHost();
      await host.update({ data: { isUSEntity: true } });
      const result = await graphqlQueryV2(query, { slug: host.slug });
      expect(result.errors).to.not.exist;
      expect(result.data.account.isUSEntity).to.be.null;
    });

    it('does not expose the isUSEntity of a money-management account to an unrelated user', async () => {
      const host = await fakeActiveHost();
      await host.update({ data: { isUSEntity: false } });
      const otherUser = await fakeUser();
      const result = await graphqlQueryV2(query, { slug: host.slug }, otherUser);
      expect(result.errors).to.not.exist;
      expect(result.data.account.isUSEntity).to.be.null;
    });
  });

  describe('members', () => {
    const query = gql`
      query MembersTest($slug: String!, $orderByTotalContributed: OrderDirection, $isActive: Boolean) {
        account(slug: $slug) {
          members(role: [BACKER], orderByTotalContributed: $orderByTotalContributed, isActive: $isActive) {
            totalCount
            nodes {
              isActive
              account {
                slug
              }
            }
          }
        }
      }
    `;

    beforeEach(async () => {
      await resetTestDB();
      await resetCaches();
    });

    it('orders members by the total amount they contributed', async () => {
      const collective = await fakeCollective();
      const small = await fakeOrganization();
      const big = await fakeOrganization();
      const none = await fakeOrganization();
      for (const backer of [none, small, big]) {
        await fakeMember({ CollectiveId: collective.id, MemberCollectiveId: backer.id, role: MemberRoles.BACKER });
      }
      await fakeTransaction({
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        FromCollectiveId: small.id,
        amount: 1000,
      });
      await fakeTransaction({
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        FromCollectiveId: big.id,
        amount: 3000,
      });
      await fakeTransaction({
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        FromCollectiveId: big.id,
        amount: 2000,
      });

      let result = await graphqlQueryV2(query, { slug: collective.slug, orderByTotalContributed: 'DESC' });
      expect(result.errors).to.not.exist;
      expect(result.data.account.members.nodes.map(n => n.account.slug)).to.deep.equal([
        big.slug,
        small.slug,
        none.slug,
      ]);

      result = await graphqlQueryV2(query, { slug: collective.slug, orderByTotalContributed: 'ASC' });
      expect(result.data.account.members.nodes.map(n => n.account.slug)).to.deep.equal([
        none.slug,
        small.slug,
        big.slug,
      ]);
    });

    it('paginates members ordered by total contributed, counting gift cards', async () => {
      const collective = await fakeCollective();
      const backers = [];
      for (let i = 0; i < 4; i++) {
        const backer = await fakeOrganization();
        await fakeMember({ CollectiveId: collective.id, MemberCollectiveId: backer.id, role: MemberRoles.BACKER });
        backers.push(backer);
      }
      const giftCardUser = await fakeOrganization();
      await fakeTransaction({
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        FromCollectiveId: backers[0].id,
        amount: 1000,
      });
      await fakeTransaction({
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        FromCollectiveId: backers[1].id,
        amount: 4000,
      });
      // backers[2] funded the gift card used for this contribution: it counts toward their total
      await fakeTransaction({
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        FromCollectiveId: giftCardUser.id,
        UsingGiftCardFromCollectiveId: backers[2].id,
        amount: 2500,
      });

      const pageQuery = gql`
        query MembersPage($slug: String!, $offset: Int!) {
          account(slug: $slug) {
            members(role: [BACKER], orderByTotalContributed: DESC, limit: 2, offset: $offset) {
              totalCount
              nodes {
                account {
                  slug
                }
              }
            }
          }
        }
      `;
      const firstPage = await graphqlQueryV2(pageQuery, { slug: collective.slug, offset: 0 });
      expect(firstPage.errors).to.not.exist;
      expect(firstPage.data.account.members.totalCount).to.equal(4);
      expect(firstPage.data.account.members.nodes.map(n => n.account.slug)).to.deep.equal([
        backers[1].slug,
        backers[2].slug,
      ]);

      const secondPage = await graphqlQueryV2(pageQuery, { slug: collective.slug, offset: 2 });
      expect(secondPage.data.account.members.nodes.map(n => n.account.slug)).to.deep.equal([
        backers[0].slug,
        backers[3].slug,
      ]);
    });

    describe('orderByTotalContributed matches Member.totalDonations', () => {
      const totalsQuery = gql`
        query MembersTotals($slug: String!, $role: [MemberRole]) {
          account(slug: $slug) {
            members(role: $role, orderByTotalContributed: DESC) {
              nodes {
                totalDonations {
                  valueInCents
                }
                account {
                  slug
                }
              }
            }
          }
        }
      `;

      afterEach(() => {
        // nockFixerRates persists its interceptor: remove it so it doesn't answer FX requests in later tests
        nock.cleanAll();
      });

      const getRanking = async (slug, role = [MemberRoles.BACKER]) => {
        const result = await graphqlQueryV2(totalsQuery, { slug, role });
        expect(result.errors).to.not.exist;
        return result.data.account.members.nodes.map(n => [n.account.slug, n.totalDonations.valueInCents]);
      };

      it('leaves out refunded contributions and fee kinds', async () => {
        const collective = await fakeCollective();
        const [refunded, feeOnly, regular] = await Promise.all([
          fakeOrganization(),
          fakeOrganization(),
          fakeOrganization(),
        ]);
        for (const backer of [refunded, feeOnly, regular]) {
          await fakeMember({ CollectiveId: collective.id, MemberCollectiveId: backer.id, role: MemberRoles.BACKER });
        }
        const refund = await fakeTransaction({
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: refunded.id,
          amount: 100,
        });
        await fakeTransaction({
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: refunded.id,
          amount: 5000,
          RefundTransactionId: refund.id,
        });
        await fakeTransaction({
          CollectiveId: collective.id,
          FromCollectiveId: feeOnly.id,
          amount: 5000,
          kind: TransactionKind.HOST_FEE,
        });
        await fakeTransaction({
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: regular.id,
          amount: 1000,
        });

        expect(await getRanking(collective.slug)).to.deep.equal([
          [regular.slug, 1000],
          [refunded.slug, 100],
          [feeOnly.slug, 0],
        ]);
      });

      it('converts each currency to the currency of the account', async () => {
        nockFixerRates({ USD: { EUR: 0.84 } });
        const collective = await fakeCollective({ currency: 'EUR' });
        const [paidInUSD, paidInEUR] = await Promise.all([fakeOrganization(), fakeOrganization()]);
        for (const backer of [paidInUSD, paidInEUR]) {
          await fakeMember({ CollectiveId: collective.id, MemberCollectiveId: backer.id, role: MemberRoles.BACKER });
        }
        // 1000 USD is 840 EUR: less than 900 EUR, even though the raw amount is higher
        await fakeTransaction({
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: paidInUSD.id,
          amount: 1000,
          currency: 'USD',
        });
        await fakeTransaction({
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          FromCollectiveId: paidInEUR.id,
          amount: 900,
          currency: 'EUR',
        });

        expect(await getRanking(collective.slug)).to.deep.equal([
          [paidInEUR.slug, 900],
          [paidInUSD.slug, 840],
        ]);
      });

      it('ranks members inherited from the parent by what they contributed to the parent', async () => {
        const parent = await fakeCollective();
        const project = await fakeProject({ ParentCollectiveId: parent.id, currency: parent.currency });
        const [parentAdmin, projectBacker] = await Promise.all([fakeOrganization(), fakeOrganization()]);
        await fakeMember({ CollectiveId: parent.id, MemberCollectiveId: parentAdmin.id, role: MemberRoles.ADMIN });
        await fakeMember({ CollectiveId: project.id, MemberCollectiveId: projectBacker.id, role: MemberRoles.BACKER });
        await fakeTransaction({
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: parent.id,
          FromCollectiveId: parentAdmin.id,
          amount: 3000,
        });
        await fakeTransaction({
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: project.id,
          FromCollectiveId: projectBacker.id,
          amount: 1000,
        });

        expect(await getRanking(project.slug, [MemberRoles.ADMIN, MemberRoles.BACKER])).to.deep.equal([
          [parentAdmin.slug, 3000],
          [projectBacker.slug, 1000],
        ]);
      });
    });

    it('filters active or inactive members, consistently with Member.isActive', async () => {
      const collective = await fakeCollective();
      const monthlyTier = await fakeTier({ CollectiveId: collective.id, interval: 'month' });
      const oneTimeTier = await fakeTier({ CollectiveId: collective.id, interval: null });

      const addBacker = async ({
        tier = null,
        lastContributionDaysAgo = null,
        kind = TransactionKind.CONTRIBUTION,
      } = {}) => {
        const backer = await fakeOrganization();
        await fakeMember({
          CollectiveId: collective.id,
          MemberCollectiveId: backer.id,
          role: MemberRoles.BACKER,
          TierId: tier?.id,
        });
        if (tier && lastContributionDaysAgo !== null) {
          const order = await fakeOrder({ CollectiveId: collective.id, FromCollectiveId: backer.id, TierId: tier.id });
          const createdAt = new Date(Date.now() - lastContributionDaysAgo * 24 * 60 * 60 * 1000);
          await fakeTransaction({
            kind,
            CollectiveId: collective.id,
            FromCollectiveId: backer.id,
            OrderId: order.id,
            amount: 1000,
            createdAt,
            clearedAt: createdAt,
          });
        }
        return backer;
      };

      const withoutTier = await addBacker();
      const oneTime = await addBacker({ tier: oneTimeTier });
      const recentMonthly = await addBacker({ tier: monthlyTier, lastContributionDaysAgo: 10 });
      const lapsedMonthly = await addBacker({ tier: monthlyTier, lastContributionDaysAgo: 90 });
      const neverChargedMonthly = await addBacker({ tier: monthlyTier });
      // Only contributions count: a recent transaction of another kind on the order does not make the member active
      const onlyRecentTipMonthly = await addBacker({
        tier: monthlyTier,
        lastContributionDaysAgo: 10,
        kind: TransactionKind.PLATFORM_TIP,
      });

      const active = await graphqlQueryV2(query, { slug: collective.slug, isActive: true });
      expect(active.errors).to.not.exist;
      expect(active.data.account.members.totalCount).to.equal(3);
      expect(active.data.account.members.nodes.map(n => n.account.slug)).to.have.members([
        withoutTier.slug,
        oneTime.slug,
        recentMonthly.slug,
      ]);
      expect(active.data.account.members.nodes.every(n => n.isActive)).to.be.true;

      const inactive = await graphqlQueryV2(query, { slug: collective.slug, isActive: false });
      expect(inactive.errors).to.not.exist;
      expect(inactive.data.account.members.totalCount).to.equal(3);
      expect(inactive.data.account.members.nodes.map(n => n.account.slug)).to.have.members([
        lapsedMonthly.slug,
        neverChargedMonthly.slug,
        onlyRecentTipMonthly.slug,
      ]);
      expect(inactive.data.account.members.nodes.every(n => !n.isActive)).to.be.true;

      const all = await graphqlQueryV2(query, { slug: collective.slug });
      expect(all.data.account.members.totalCount).to.equal(6);
    });

    it('breaks ties between equal totals with orderBy', async () => {
      const collective = await fakeCollective();
      const backers = [];
      for (const daysAgo of [3, 1, 2]) {
        const backer = await fakeOrganization();
        await fakeMember({
          CollectiveId: collective.id,
          MemberCollectiveId: backer.id,
          role: MemberRoles.BACKER,
          createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
        });
        backers.push({ backer, daysAgo });
      }
      const top = await fakeOrganization();
      await fakeMember({ CollectiveId: collective.id, MemberCollectiveId: top.id, role: MemberRoles.BACKER });
      await fakeTransaction({
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        FromCollectiveId: top.id,
        amount: 1000,
      });

      const tieQuery = gql`
        query MembersTieTest($slug: String!, $direction: OrderDirection!) {
          account(slug: $slug) {
            members(
              role: [BACKER]
              orderByTotalContributed: DESC
              orderBy: { field: CREATED_AT, direction: $direction }
            ) {
              nodes {
                account {
                  slug
                }
              }
            }
          }
        }
      `;
      const oldestFirst = [...backers].sort((a, b) => b.daysAgo - a.daysAgo).map(b => b.backer.slug);

      let result = await graphqlQueryV2(tieQuery, { slug: collective.slug, direction: 'ASC' });
      expect(result.errors).to.not.exist;
      expect(result.data.account.members.nodes.map(n => n.account.slug)).to.deep.equal([top.slug, ...oldestFirst]);

      result = await graphqlQueryV2(tieQuery, { slug: collective.slug, direction: 'DESC' });
      expect(result.errors).to.not.exist;
      expect(result.data.account.members.nodes.map(n => n.account.slug)).to.deep.equal([
        top.slug,
        ...[...oldestFirst].reverse(),
      ]);
    });

    it('combines isActive with orderByTotalContributed, with consistent pagination', async () => {
      const collective = await fakeCollective();
      const monthlyTier = await fakeTier({ CollectiveId: collective.id, interval: 'month' });

      const addBacker = async ({ amount = 0, monthlyDaysAgo = null } = {}) => {
        const backer = await fakeOrganization();
        await fakeMember({
          CollectiveId: collective.id,
          MemberCollectiveId: backer.id,
          role: MemberRoles.BACKER,
          TierId: monthlyDaysAgo !== null ? monthlyTier.id : null,
        });
        if (amount) {
          const order =
            monthlyDaysAgo !== null
              ? await fakeOrder({ CollectiveId: collective.id, FromCollectiveId: backer.id, TierId: monthlyTier.id })
              : null;
          await fakeTransaction({
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: collective.id,
            FromCollectiveId: backer.id,
            OrderId: order?.id,
            amount,
            ...(monthlyDaysAgo !== null && {
              createdAt: new Date(Date.now() - monthlyDaysAgo * 24 * 60 * 60 * 1000),
              clearedAt: new Date(Date.now() - monthlyDaysAgo * 24 * 60 * 60 * 1000),
            }),
          });
        }
        return backer;
      };

      const activeSmall = await addBacker({ amount: 1000 });
      const activeBig = await addBacker({ amount: 5000, monthlyDaysAgo: 10 });
      const activeMedium = await addBacker({ amount: 3000 });
      await addBacker({ amount: 9000, monthlyDaysAgo: 90 }); // Lapsed: inactive despite the largest total

      const pagedQuery = gql`
        query MembersActivePagedTest($slug: String!, $offset: Int!) {
          account(slug: $slug) {
            members(role: [BACKER], isActive: true, orderByTotalContributed: DESC, limit: 2, offset: $offset) {
              totalCount
              nodes {
                isActive
                account {
                  slug
                }
              }
            }
          }
        }
      `;

      const page1 = await graphqlQueryV2(pagedQuery, { slug: collective.slug, offset: 0 });
      expect(page1.errors).to.not.exist;
      expect(page1.data.account.members.totalCount).to.equal(3);
      expect(page1.data.account.members.nodes.map(n => n.account.slug)).to.deep.equal([
        activeBig.slug,
        activeMedium.slug,
      ]);

      const page2 = await graphqlQueryV2(pagedQuery, { slug: collective.slug, offset: 2 });
      expect(page2.errors).to.not.exist;
      expect(page2.data.account.members.totalCount).to.equal(3);
      expect(page2.data.account.members.nodes.map(n => n.account.slug)).to.deep.equal([activeSmall.slug]);
      expect([...page1.data.account.members.nodes, ...page2.data.account.members.nodes].every(n => n.isActive)).to.be
        .true;
    });
  });

  describe('expenses', () => {
    const query = gql`
      query AccountExpensesTest($slug: String!) {
        account(slug: $slug) {
          all: expenses {
            totalCount
            nodes {
              description
            }
            payees {
              nodes {
                slug
              }
            }
          }
          submitted: expenses(direction: SUBMITTED) {
            totalCount
          }
          received: expenses(direction: RECEIVED) {
            totalCount
          }
        }
      }
    `;

    let collective, adminUser, user, unrelatedPayee;

    before(async () => {
      await resetTestDB();
      adminUser = await fakeUser();
      user = await fakeUser();
      collective = await fakeCollective({ admin: adminUser });
      const otherCollective = await fakeCollective();
      unrelatedPayee = await fakeCollective();
      await fakeExpense({ CollectiveId: otherCollective.id, FromCollectiveId: unrelatedPayee.id });
      const privateHost = await fakePrivateHost();
      const privateCollective = await fakeCollective({
        HostCollectiveId: privateHost.id,
        isPrivate: true,
        approvedAt: new Date(),
      });

      await fakeExpense({ CollectiveId: collective.id, FromCollectiveId: user.CollectiveId, description: 'Received' });
      await fakeExpense({
        CollectiveId: otherCollective.id,
        FromCollectiveId: collective.id,
        description: 'Submitted',
      });
      await fakeExpense({
        CollectiveId: privateCollective.id,
        FromCollectiveId: collective.id,
        description: 'Submitted to private',
      });
    });

    it('returns both submitted and received expenses when no direction is given', async () => {
      const result = await graphqlQueryV2(query, { slug: collective.slug });
      expect(result.errors).to.not.exist;
      expect(result.data.account.received.totalCount).to.eq(1);
      expect(result.data.account.submitted.totalCount).to.eq(1);
      expect(result.data.account.all.totalCount).to.eq(2);
      expect(result.data.account.all.nodes.map(n => n.description)).to.have.members(['Received', 'Submitted']);
    });

    it('scopes payees to expenses submitted or received by the account', async () => {
      const result = await graphqlQueryV2(query, { slug: collective.slug });
      expect(result.errors).to.not.exist;
      const payeeSlugs = result.data.account.all.payees.nodes.map(n => n.slug);
      expect(payeeSlugs).to.have.members([user.collective.slug, collective.slug]);
      expect(payeeSlugs).to.not.include(unrelatedPayee.slug);
    });

    it('returns the same received expenses as direction RECEIVED when including children', async () => {
      const parent = await fakeCollective();
      const privateChild = await fakeProject({ ParentCollectiveId: parent.id, isPrivate: true });
      await fakeExpense({ CollectiveId: privateChild.id, FromCollectiveId: user.CollectiveId });

      const childrenQuery = gql`
        query AccountExpensesChildrenTest($slug: String!) {
          account(slug: $slug) {
            all: expenses(includeChildrenExpenses: true) {
              totalCount
            }
            received: expenses(direction: RECEIVED, includeChildrenExpenses: true) {
              totalCount
            }
          }
        }
      `;
      const result = await graphqlQueryV2(childrenQuery, { slug: parent.slug });
      expect(result.errors).to.not.exist;
      expect(result.data.account.received.totalCount).to.eq(1);
      expect(result.data.account.all.totalCount).to.eq(1);
    });

    it('keeps expenses submitted to private accounts hidden when filtering by host', async () => {
      const host = await fakeActiveHost();
      const hostedCollective = await fakeCollective({ HostCollectiveId: host.id, approvedAt: new Date() });
      const privateHostedCollective = await fakeCollective({
        HostCollectiveId: host.id,
        isPrivate: true,
        approvedAt: new Date(),
      });
      await fakeExpense({
        CollectiveId: privateHostedCollective.id,
        FromCollectiveId: hostedCollective.id,
        HostCollectiveId: host.id,
        description: 'Submitted to private',
      });
      await fakeExpense({
        CollectiveId: hostedCollective.id,
        FromCollectiveId: user.CollectiveId,
        HostCollectiveId: host.id,
        description: 'Received',
      });

      const hostQuery = gql`
        query AccountExpensesHostTest($slug: String!, $host: AccountReferenceInput!) {
          account(slug: $slug) {
            expenses(host: $host) {
              nodes {
                description
              }
            }
          }
        }
      `;
      const variables = { slug: hostedCollective.slug, host: { slug: host.slug } };
      const result = await graphqlQueryV2(hostQuery, variables);
      expect(result.errors).to.not.exist;
      expect(result.data.account.expenses.nodes.map(n => n.description)).to.deep.eq(['Received']);

      const hostAdmin = await fakeUser();
      await host.addUserWithRole(hostAdmin, 'ADMIN');
      const adminResult = await graphqlQueryV2(hostQuery, variables, hostAdmin);
      expect(adminResult.errors).to.not.exist;
      expect(adminResult.data.account.expenses.nodes.map(n => n.description)).to.have.members([
        'Received',
        'Submitted to private',
      ]);
    });

    it('includes expenses submitted to private accounts only for those who can see them', async () => {
      const result = await graphqlQueryV2(query, { slug: collective.slug }, adminUser);
      expect(result.errors).to.not.exist;
      expect(result.data.account.submitted.totalCount).to.eq(2);
      expect(result.data.account.all.totalCount).to.eq(3);
    });
  });

  describe('memberOf', () => {
    const query = gql`
      query MemberOfTest($slug: String!, $tier: TierReferenceInput, $account: AccountReferenceInput) {
        account(slug: $slug) {
          memberOf(tier: $tier, account: $account) {
            totalCount
            nodes {
              tier {
                legacyId
              }
              account {
                slug
              }
            }
          }
        }
      }
    `;

    beforeEach(async () => {
      await resetTestDB();
    });

    it('filters active or inactive memberships', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const otherCollective = await fakeCollective();
      const monthlyTier = await fakeTier({ CollectiveId: collective.id, interval: 'month' });
      await fakeMember({
        CollectiveId: collective.id,
        MemberCollectiveId: user.CollectiveId,
        role: MemberRoles.BACKER,
        TierId: monthlyTier.id,
      });
      await fakeMember({
        CollectiveId: otherCollective.id,
        MemberCollectiveId: user.CollectiveId,
        role: MemberRoles.BACKER,
      });

      const activeQuery = gql`
        query MemberOfActive($slug: String!, $isActive: Boolean) {
          account(slug: $slug) {
            memberOf(isActive: $isActive) {
              totalCount
              nodes {
                account {
                  slug
                }
              }
            }
          }
        }
      `;
      const active = await graphqlQueryV2(activeQuery, { slug: user.collective.slug, isActive: true }, user);
      expect(active.errors).to.not.exist;
      expect(active.data.account.memberOf.nodes.map(n => n.account.slug)).to.deep.equal([otherCollective.slug]);

      const inactive = await graphqlQueryV2(activeQuery, { slug: user.collective.slug, isActive: false }, user);
      expect(inactive.data.account.memberOf.nodes.map(n => n.account.slug)).to.deep.equal([collective.slug]);
    });

    it('returns only the memberships recorded with the given tier', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const otherCollective = await fakeCollective();
      const tier = await fakeTier({ CollectiveId: collective.id });
      await fakeMember({
        CollectiveId: collective.id,
        MemberCollectiveId: user.CollectiveId,
        role: MemberRoles.BACKER,
        TierId: tier.id,
      });
      await fakeMember({
        CollectiveId: otherCollective.id,
        MemberCollectiveId: user.CollectiveId,
        role: MemberRoles.BACKER,
      });

      const result = await graphqlQueryV2(query, { slug: user.collective.slug, tier: { legacyId: tier.id } }, user);
      expect(result.errors).to.not.exist;
      expect(result.data.account.memberOf.totalCount).to.equal(1);
      expect(result.data.account.memberOf.nodes[0].account.slug).to.equal(collective.slug);
      expect(result.data.account.memberOf.nodes[0].tier.legacyId).to.equal(tier.id);
    });

    it('returns only the memberships without tier when tier is null', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const otherCollective = await fakeCollective();
      const tier = await fakeTier({ CollectiveId: collective.id });
      await fakeMember({
        CollectiveId: collective.id,
        MemberCollectiveId: user.CollectiveId,
        role: MemberRoles.BACKER,
        TierId: tier.id,
      });
      await fakeMember({
        CollectiveId: otherCollective.id,
        MemberCollectiveId: user.CollectiveId,
        role: MemberRoles.BACKER,
      });

      const result = await graphqlQueryV2(query, { slug: user.collective.slug, tier: null }, user);
      expect(result.errors).to.not.exist;
      expect(result.data.account.memberOf.totalCount).to.equal(1);
      expect(result.data.account.memberOf.nodes[0].account.slug).to.equal(otherCollective.slug);
    });

    it('rejects a tier that belongs to another account when the query is scoped to a single account', async () => {
      // Note: the account-scoped check is the only place where the tier ownership is asserted: `memberOf` lists
      // memberships in *other* accounts, so the tier never belongs to the account the memberships are listed for.
      const user = await fakeUser();
      const collective = await fakeCollective();
      const otherCollective = await fakeCollective();
      const otherTier = await fakeTier({ CollectiveId: otherCollective.id });
      await fakeMember({
        CollectiveId: collective.id,
        MemberCollectiveId: user.CollectiveId,
        role: MemberRoles.BACKER,
      });

      const result = await graphqlQueryV2(
        query,
        {
          slug: user.collective.slug,
          account: { legacyId: collective.id },
          tier: { legacyId: otherTier.id },
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Tier is not associated with this collective');
    });
  });

  describe('feed', () => {
    const feedQuery = gql`
      query AccountFeed($slug: String!, $classes: [ActivityClassType!], $limit: Int) {
        account(slug: $slug) {
          id
          feed(classes: $classes, limit: $limit) {
            id
          }
        }
      }
    `;

    it('does not throw when classes is omitted', async () => {
      const admin = await fakeUser();
      const collective = await fakeCollective({ admin });
      await fakeActivity({ CollectiveId: collective.id, type: 'collective.expense.created' });
      const result = await graphqlQueryV2(feedQuery, { slug: collective.slug }, admin);
      expect(result.errors).to.not.exist;
      expect(result.data.account.feed).to.be.an('array');
    });

    it('returns an empty list when classes is empty', async () => {
      const admin = await fakeUser();
      const collective = await fakeCollective({ admin });
      const result = await graphqlQueryV2(feedQuery, { slug: collective.slug, classes: [] }, admin);
      expect(result.errors).to.not.exist;
      expect(result.data.account.feed).to.deep.equal([]);
    });
  });
});
