import { expect } from 'chai';

import { manualKycProvider } from '../../../../server/lib/kyc/providers/manual';
import { KYCProviderName, KYCVerificationStatus } from '../../../../server/models/KYCVerification';
import { fakeKYCVerification, fakeOrganization, fakeUser } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('server/lib/kyc/manual', () => {
  describe('request', () => {
    beforeEach(async () => {
      await resetTestDB();
    });
    it('throws if account already verified for requester', async () => {
      const org = await fakeOrganization();
      const user = await fakeUser();
      await fakeKYCVerification({
        provider: KYCProviderName.MANUAL,
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: org.id,
        status: KYCVerificationStatus.VERIFIED,
      });

      await expect(
        manualKycProvider.request(
          {
            CollectiveId: user.collective.id,
            RequestedByCollectiveId: org.id,
          },
          {
            legalName: 'Legal name',
            legalAddress: 'Legal address',
            notes: 'notes',
          },
        ),
      ).to.eventually.be.rejectedWith('Account already verified with manual provider');
    });

    it('it creates VERIFIED verification', async () => {
      const org = await fakeOrganization();
      const otherOrg = await fakeOrganization();
      const user = await fakeUser();
      await fakeKYCVerification({
        provider: KYCProviderName.MANUAL,
        CollectiveId: otherOrg.id,
        RequestedByCollectiveId: user.collective.id,
        status: KYCVerificationStatus.VERIFIED,
      });

      await fakeKYCVerification({
        provider: KYCProviderName.MANUAL,
        CollectiveId: org.id,
        RequestedByCollectiveId: user.collective.id,
        status: KYCVerificationStatus.REVOKED,
      });

      const kycVerification = await manualKycProvider.request(
        {
          CollectiveId: org.id,
          RequestedByCollectiveId: user.collective.id,
        },
        {
          legalName: 'Legal name',
          legalAddress: 'Legal address',
          notes: 'notes',
        },
      );

      expect(kycVerification).to.exist;
      expect(kycVerification.status).to.eql(KYCVerificationStatus.VERIFIED);
      expect(kycVerification.providerData).to.eql({
        notes: 'notes',
      });

      expect(kycVerification.data).to.eql({
        legalName: 'Legal name',
        legalAddress: 'Legal address',
      });
    });
  });
});
