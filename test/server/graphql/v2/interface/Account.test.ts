import { expect } from 'chai';
import gql from 'fake-tag';

import { KYCVerificationStatus } from '../../../../../server/models/KYCVerification';
import { fakeKYCVerification, fakeOrganization, fakeUser } from '../../../../test-helpers/fake-data';
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
});
