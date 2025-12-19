import { expect } from 'chai';
import gql from 'fake-tag';
import { beforeEach } from 'mocha';
import sinon from 'sinon';

import FEATURE from '../../../../../server/constants/feature';
import { KYCProviderName } from '../../../../../server/lib/kyc/providers';
import { manualKycProvider } from '../../../../../server/lib/kyc/providers/manual';
import { KYCVerificationStatus } from '../../../../../server/models/KYCVerification';
import { fakeKYCVerification, fakeOrganization, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

describe('server/graphql/v2/mutation/KYCMutations', () => {
  describe('requestKYCVerification', () => {
    beforeEach(async () => {
      await resetTestDB();
    });
    const sandbox = sinon.createSandbox();
    afterEach(() => {
      sandbox.restore();
    });

    const mutation = gql`
      mutation RequestKYCVerification(
        $requestedByAccount: AccountReferenceInput!
        $verifyAccount: AccountReferenceInput!
        $provider: KYCProvider!
        $request: RequestKYCVerificationInput!
      ) {
        requestKYCVerification(
          requestedByAccount: $requestedByAccount
          verifyAccount: $verifyAccount
          provider: $provider
          request: $request
        ) {
          status
          provider
        }
      }
    `;

    const manualProviderArgs = {
      manual: {
        legalName: 'legal name',
        legalAddress: 'legal address',
        notes: 'notes',
      },
    };

    async function setupOrg(opts = {}) {
      const org = await fakeOrganization({
        ...opts,
        hasMoneyManagement: true,
        data: {
          isFirstPartyHost: true,
          features: { [FEATURE.KYC]: true },
        },
      });

      return org;
    }

    it('returns error if user is not authenticated', async () => {
      const org = await setupOrg();
      const user = await fakeUser();

      const result = await graphqlQueryV2(mutation, {
        requestedByAccount: { slug: org.slug },
        verifyAccount: { slug: user.collective.slug },
        provider: 'MANUAL',
        request: {
          ...manualProviderArgs,
        },
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage KYC.');
    });

    it('returns error if org has no feature access', async () => {
      const orgAdmin = await fakeUser();
      const org = await fakeOrganization({ admin: orgAdmin });
      const user = await fakeUser();

      const result = await graphqlQueryV2(
        mutation,
        {
          requestedByAccount: { slug: org.slug },
          verifyAccount: { slug: user.collective.slug },
          provider: 'MANUAL',
          request: {
            ...manualProviderArgs,
          },
        },
        orgAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('This feature is not supported for your account');
    });

    it('returns error if user is not organization admin', async () => {
      const orgAdmin = await fakeUser();
      const otherUser = await fakeUser();
      const org = await setupOrg({ admin: orgAdmin });
      const user = await fakeUser();

      const result = await graphqlQueryV2(
        mutation,
        {
          requestedByAccount: { slug: org.slug },
          verifyAccount: { slug: user.collective.slug },
          provider: 'MANUAL',
          request: {
            ...manualProviderArgs,
          },
        },
        otherUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You are authenticated but forbidden to perform this action');
    });

    it('returns error if verify account does not exist', async () => {
      const orgAdmin = await fakeUser();
      const org = await setupOrg({ admin: orgAdmin });
      const user = await fakeUser();
      await user.collective.destroy();

      const result = await graphqlQueryV2(
        mutation,
        {
          requestedByAccount: { slug: org.slug },
          verifyAccount: { slug: user.collective.slug },
          provider: 'MANUAL',
          request: {
            ...manualProviderArgs,
          },
        },
        orgAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Account Not Found');
    });
    it('returns error if request account does not exist', async () => {
      const orgAdmin = await fakeUser();
      const org = await setupOrg({ admin: orgAdmin });
      await org.destroy();
      const user = await fakeUser();

      const result = await graphqlQueryV2(
        mutation,
        {
          requestedByAccount: { slug: org.slug },
          verifyAccount: { slug: user.collective.slug },
          provider: 'MANUAL',
          request: {
            ...manualProviderArgs,
          },
        },
        orgAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Account Not Found');
    });

    it('returns error if provider request fails', async () => {
      sandbox.stub(manualKycProvider, 'request').rejects(new Error('Request failed'));
      const orgAdmin = await fakeUser();
      const org = await setupOrg({ admin: orgAdmin });
      const user = await fakeUser();

      const result = await graphqlQueryV2(
        mutation,
        {
          requestedByAccount: { slug: org.slug },
          verifyAccount: { slug: user.collective.slug },
          provider: 'MANUAL',
          request: {
            ...manualProviderArgs,
          },
        },
        orgAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Request failed');
    });

    it('calls provider with args', async () => {
      const orgAdmin = await fakeUser();
      const org = await setupOrg({ admin: orgAdmin });
      const user = await fakeUser();

      const expected = await fakeKYCVerification({
        RequestedByCollectiveId: org.id,
        CollectiveId: user.collective.id,
        provider: KYCProviderName.MANUAL,
      });

      const kycProviderStub = sandbox.stub(manualKycProvider, 'request').resolves(expected);

      const result = await graphqlQueryV2(
        mutation,
        {
          requestedByAccount: { slug: org.slug },
          verifyAccount: { slug: user.collective.slug },
          provider: 'MANUAL',
          request: {
            ...manualProviderArgs,
          },
        },
        orgAdmin,
      );

      expect(kycProviderStub).to.have.been.calledWithMatch(
        {
          CollectiveId: user.collective.id,
          RequestedByCollectiveId: org.id,
        },
        {
          legalName: 'legal name',
          legalAddress: 'legal address',
          notes: 'notes',
        },
      );

      expect(result.errors).to.not.exist;
      expect(result.data.requestKYCVerification).to.exist;
    });
  });
  describe('revokeKYCVerification', () => {
    beforeEach(async () => {
      await resetTestDB();
    });
    const sandbox = sinon.createSandbox();
    afterEach(() => {
      sandbox.restore();
    });

    const mutation = gql`
      mutation RevokeKYCVerification($kycVerification: KYCVerificationReferenceInput!) {
        revokeKYCVerification(kycVerification: $kycVerification) {
          status
        }
      }
    `;

    async function setupOrg(opts = {}) {
      const org = await fakeOrganization({
        ...opts,
        hasMoneyManagement: true,
        data: {
          isFirstPartyHost: true,
          features: { [FEATURE.KYC]: true },
        },
      });

      return org;
    }

    it('returns error if user is not authenticated', async () => {
      const org = await setupOrg();

      const kycVerification = await fakeKYCVerification({
        RequestedByCollectiveId: org.id,
        status: KYCVerificationStatus.VERIFIED,
      });

      const result = await graphqlQueryV2(mutation, {
        kycVerification: kycVerification.id,
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage KYC.');
    });

    it('returns error if org has no feature access', async () => {
      const orgAdmin = await fakeUser();
      const org = await fakeOrganization({ admin: orgAdmin });

      const kycVerification = await fakeKYCVerification({
        RequestedByCollectiveId: org.id,
      });

      const result = await graphqlQueryV2(
        mutation,
        {
          kycVerification: kycVerification.id,
          status: KYCVerificationStatus.VERIFIED,
        },
        orgAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('This feature is not supported for your account');
    });

    it('returns error if user is not organization admin', async () => {
      const otherUser = await fakeUser();
      const org = await setupOrg();

      const kycVerification = await fakeKYCVerification({
        RequestedByCollectiveId: org.id,
        status: KYCVerificationStatus.VERIFIED,
      });

      const result = await graphqlQueryV2(
        mutation,
        {
          kycVerification: kycVerification.id,
        },
        otherUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You are authenticated but forbidden to perform this action');
    });

    it('returns error if kyc verification does not exist', async () => {
      const orgAdmin = await fakeUser();
      const org = await setupOrg({ admin: orgAdmin });

      const kycVerification = await fakeKYCVerification({
        RequestedByCollectiveId: org.id,
        status: KYCVerificationStatus.VERIFIED,
      });
      await kycVerification.destroy();

      const result = await graphqlQueryV2(
        mutation,
        {
          kycVerification: kycVerification.id,
        },
        orgAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('KYC Verification not found');
    });

    it('individual cannot revoke own verification', async () => {
      const orgAdmin = await fakeUser();
      const user = await fakeUser();
      const org = await setupOrg({ admin: orgAdmin });

      const kycVerification = await fakeKYCVerification({
        RequestedByCollectiveId: org.id,
        CollectiveId: user.collective.id,
        status: KYCVerificationStatus.VERIFIED,
      });

      const result = await graphqlQueryV2(
        mutation,
        {
          kycVerification: kycVerification.id,
        },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You are authenticated but forbidden to perform this action');
    });

    it('revokes individual verification', async () => {
      const orgAdmin = await fakeUser();
      const user = await fakeUser();
      const org = await setupOrg({ admin: orgAdmin });

      const kycVerification = await fakeKYCVerification({
        RequestedByCollectiveId: org.id,
        CollectiveId: user.collective.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
      });

      const result = await graphqlQueryV2(
        mutation,
        {
          kycVerification: kycVerification.id,
        },
        orgAdmin,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.revokeKYCVerification.status).to.equal(KYCVerificationStatus.REVOKED);

      await kycVerification.reload();
      expect(kycVerification.status).to.eql(KYCVerificationStatus.REVOKED);
    });

    it('return error if provider revoke fails', async () => {
      sandbox.stub(manualKycProvider, 'revoke').rejects(new Error('Revoke failed'));
      const orgAdmin = await fakeUser();
      const user = await fakeUser();
      const org = await setupOrg({ admin: orgAdmin });

      const kycVerification = await fakeKYCVerification({
        RequestedByCollectiveId: org.id,
        CollectiveId: user.collective.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
      });

      const result = await graphqlQueryV2(
        mutation,
        {
          kycVerification: kycVerification.id,
        },
        orgAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Revoke failed');

      await kycVerification.reload();
      expect(kycVerification.status).to.eql(KYCVerificationStatus.VERIFIED);
    });
  });
});
