import { expect } from 'chai';
import gql from 'fake-tag';

import MemberRoles from '../../../../../server/constants/roles';
import { KYCVerificationStatus } from '../../../../../server/models/KYCVerification';
import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import {
  fakeActiveHost,
  fakeCollective,
  fakeEvent,
  fakeIncognitoProfile,
  fakeKYCVerification,
  fakeMember,
  fakeOrganization,
  fakePayoutMethod,
  fakeProject,
  fakeTier,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

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

    it('returns the main profile for an admin of a collective who received an incognito contribution', async () => {
      const user = await fakeUser();
      const incognito = await fakeIncognitoProfile(user);
      const collectiveAdmin = await fakeUser();
      const collective = await fakeCollective({ admin: collectiveAdmin });
      // Simulate a contribution from the incognito profile to the collective
      await fakeMember({ CollectiveId: collective.id, MemberCollectiveId: incognito.id, role: MemberRoles.BACKER });
      const result = await graphqlQueryV2(query, { slug: incognito.slug }, collectiveAdmin);
      expect(result.errors).to.not.exist;
      expect(result.data.account.isIncognito).to.be.true;
      expect(result.data.account.mainProfile).to.exist;
      expect(result.data.account.mainProfile.slug).to.equal(user.collective.slug);
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

  describe('payoutMethods', () => {
    const query = gql`
      query AccountPayoutMethods($slug: String!) {
        account(slug: $slug) {
          id
          payoutMethods {
            id
            publicId
            type
            name
            data
          }
        }
      }
    `;

    let host, otherHost, hostAdmin, bankAccount, paypal, other;

    before(async () => {
      await resetTestDB();
      hostAdmin = await fakeUser();
      host = await fakeActiveHost({ admin: hostAdmin });
      otherHost = await fakeActiveHost();
      const bankData = {
        accountHolderName: 'Host Inc',
        currency: 'USD',
        type: 'aba',
        details: { accountNumber: '123' },
      };
      bankAccount = await fakePayoutMethod({
        CollectiveId: host.id,
        type: PayoutMethodTypes.BANK_ACCOUNT,
        currency: 'USD',
        data: bankData,
      });
      paypal = await fakePayoutMethod({
        CollectiveId: host.id,
        type: PayoutMethodTypes.PAYPAL,
        currency: 'USD',
        data: { email: 'host@example.com' },
      });
      other = await fakePayoutMethod({
        CollectiveId: host.id,
        type: PayoutMethodTypes.OTHER,
        data: { content: 'Cash' },
      });
      await fakePayoutMethod({
        // Archived, never returned
        CollectiveId: host.id,
        type: PayoutMethodTypes.BANK_ACCOUNT,
        isSaved: false,
        currency: 'USD',
        data: bankData,
      });
    });

    const getPayoutMethods = async user => {
      const result = await graphqlQueryV2(query, { slug: host.slug }, user);
      expect(result.errors).to.not.exist;
      return result.data.account.payoutMethods;
    };

    it('returns all saved payout methods with their details to host admins', async () => {
      const payoutMethods = await getPayoutMethods(hostAdmin);
      expect(payoutMethods.map(pm => pm.publicId)).to.deep.equal([
        bankAccount.publicId,
        paypal.publicId,
        other.publicId,
      ]);
      expect(payoutMethods[0].data).to.exist;
    });

    it('returns null for unauthenticated users and users without a hosted account', async () => {
      expect(await getPayoutMethods(null)).to.be.null;
      expect(await getPayoutMethods(await fakeUser())).to.be.null;
    });

    it('returns null for admins of accounts hosted by another host', async () => {
      const user = await fakeUser();
      await fakeCollective({ admin: user, HostCollectiveId: otherHost.id });
      expect(await getPayoutMethods(user)).to.be.null;
    });

    it('returns null for admins of accounts that are not approved yet', async () => {
      const user = await fakeUser();
      await fakeCollective({ admin: user, HostCollectiveId: host.id, isActive: false, approvedAt: null });
      expect(await getPayoutMethods(user)).to.be.null;
    });

    describe('for admins of hosted accounts (expenses across hosts)', () => {
      const expectCrossHostPayoutMethods = payoutMethods => {
        expect(payoutMethods.map(pm => pm.publicId)).to.deep.equal([bankAccount.publicId, paypal.publicId]);
        payoutMethods.forEach(pm => {
          expect(pm.data).to.be.null;
          expect(pm.name).to.be.null;
        });
      };

      it('returns saved bank accounts and PayPal, without details, to collective admins', async () => {
        const user = await fakeUser();
        await fakeCollective({ admin: user, HostCollectiveId: host.id });
        expectCrossHostPayoutMethods(await getPayoutMethods(user));
      });

      it('works for admins of a project whose parent is hosted', async () => {
        const user = await fakeUser();
        const collective = await fakeCollective({ HostCollectiveId: host.id });
        await fakeProject({ admin: user, ParentCollectiveId: collective.id });
        expectCrossHostPayoutMethods(await getPayoutMethods(user));
      });

      it('works for admins of an event whose parent is the host', async () => {
        const user = await fakeUser();
        await fakeEvent({ admin: user, ParentCollectiveId: host.id });
        expectCrossHostPayoutMethods(await getPayoutMethods(user));
      });
    });
  });
});
