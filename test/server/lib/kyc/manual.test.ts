import { expect } from 'chai';

import ActivityTypes from '../../../../server/constants/activities';
import { KYCProviderName } from '../../../../server/lib/kyc/providers';
import { manualKycProvider } from '../../../../server/lib/kyc/providers/manual';
import { Activity } from '../../../../server/models';
import { KYCVerificationStatus } from '../../../../server/models/KYCVerification';
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
            CreatedByUserId: user.id,
            UserTokenId: null,
          },
          {
            legalName: 'Legal name',
            legalAddress: 'Legal address',
            notes: 'notes',
          },
        ),
      ).to.eventually.be.rejectedWith('Account already verified with this KYC provider');
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
          CreatedByUserId: user.id,
          UserTokenId: null,
        },
        {
          legalName: 'Legal name',
          legalAddress: 'Legal address',
          notes: 'notes',
        },
      );

      expect(kycVerification).to.exist;
      expect(kycVerification.status).to.eql(KYCVerificationStatus.VERIFIED);
      expect(kycVerification.CreatedByUserId).to.equal(user.id);
      expect(kycVerification.providerData).to.eql({
        notes: 'notes',
      });

      expect(kycVerification.data).to.eql({
        legalName: 'Legal name',
        legalAddress: 'Legal address',
      });

      const activity = await Activity.findOne({
        where: {
          type: ActivityTypes.KYC_REQUESTED,
          CollectiveId: org.id,
          FromCollectiveId: user.collective.id,
        },
      });
      expect(activity).to.exist;
      expect(activity.UserId).to.equal(user.id);
      expect(activity.UserTokenId).to.equal(null);
    });

    it('it creates VERIFIED verification without legal address', async () => {
      const org = await fakeOrganization();
      const user = await fakeUser();

      const kycVerification = await manualKycProvider.request(
        {
          CollectiveId: org.id,
          RequestedByCollectiveId: user.collective.id,
          CreatedByUserId: user.id,
          UserTokenId: null,
        },
        {
          legalName: 'Legal name',
          notes: 'notes',
        },
      );

      expect(kycVerification).to.exist;
      expect(kycVerification.status).to.eql(KYCVerificationStatus.VERIFIED);
      expect(kycVerification.data.legalName).to.eql('Legal name');
      expect(kycVerification.data.legalAddress).to.be.undefined;
    });
  });
});
