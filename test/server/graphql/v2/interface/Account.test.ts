import { expect } from 'chai';
import gql from 'fake-tag';

import MemberRoles from '../../../../../server/constants/roles';
import { KYCVerificationStatus } from '../../../../../server/models/KYCVerification';
import {
  fakeActiveHost,
  fakeCollective,
  fakeIncognitoProfile,
  fakeKYCVerification,
  fakeMember,
  fakeOrganization,
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
});
