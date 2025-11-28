import { expect } from 'chai';
import gql from 'fake-tag';
import { beforeEach } from 'mocha';
import sinon from 'sinon';

import { manualKycProvider } from '../../../../../server/lib/kyc/providers/manual';
import { KYCProviderName } from '../../../../../server/models/KYCVerification';
import {
  fakeKYCVerification,
  fakeOrganization,
  fakePlatformSubscription,
  fakeUser,
} from '../../../../test-helpers/fake-data';
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
        isHostAccount: true,
        data: {
          isFirstPartyHost: true,
        },
      });
      await fakePlatformSubscription({
        CollectiveId: org.id,
        plan: { features: { KYC: true } },
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
});
