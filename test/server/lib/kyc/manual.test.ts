import { expect } from 'chai';
import sinon from 'sinon';

import { KYCProviderName } from '../../../../server/lib/kyc/providers';
import { manualKycProvider } from '../../../../server/lib/kyc/providers/manual';
import { KYCVerificationStatus } from '../../../../server/models/KYCVerification';
import { fakeKYCVerification, fakeOrganization, fakeUser } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('server/lib/kyc/manual', () => {
  describe('request', () => {
    let sandbox: sinon.SinonSandbox;
    beforeEach(async () => {
      await resetTestDB();
      sandbox = sinon.createSandbox();
    });

    afterEach(() => {
      sandbox.restore();
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
        manualKycProvider.requestVerification(
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
            UserTokenId: null,
          },
        ),
      ).to.eventually.be.rejectedWith('Account already verified with this KYC provider');
    });

    it('it creates VERIFIED verification', async () => {
      const handleKycVerifiedStub = sandbox.stub(manualKycProvider, 'handleKycVerified').resolves();

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

      const kycVerification = await manualKycProvider.requestVerification(
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
          UserTokenId: null,
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

      expect(handleKycVerifiedStub).to.have.been.calledWith(kycVerification);
    });

    it('it creates VERIFIED verification without legal address', async () => {
      const handleKycVerifiedStub = sandbox.stub(manualKycProvider, 'handleKycVerified').resolves();
      const org = await fakeOrganization();
      const user = await fakeUser();

      const kycVerification = await manualKycProvider.requestVerification(
        {
          CollectiveId: org.id,
          RequestedByCollectiveId: user.collective.id,
          CreatedByUserId: user.id,
          UserTokenId: null,
        },
        {
          legalName: 'Legal name',
          notes: 'notes',
          UserTokenId: null,
        },
      );

      expect(kycVerification).to.exist;
      expect(kycVerification.status).to.eql(KYCVerificationStatus.VERIFIED);
      expect(kycVerification.data.legalName).to.eql('Legal name');
      expect(kycVerification.data.legalAddress).to.be.undefined;

      expect(handleKycVerifiedStub).to.have.been.calledWith(kycVerification);
    });
  });
});
