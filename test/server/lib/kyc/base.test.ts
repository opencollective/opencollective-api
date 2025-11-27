import { expect } from 'chai';

import { KYCProvider } from '../../../../server/lib/kyc/providers/base';
import { KYCProviderName, KYCVerification, KYCVerificationStatus } from '../../../../server/models/KYCVerification';
import { fakeKYCVerification, fakeOrganization, fakeUser } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

class TestProvider extends KYCProvider<unknown> {
  constructor() {
    super('test' as KYCProviderName);
  }

  request(): Promise<KYCVerification> {
    throw new Error('Method not implemented.');
  }
}

const testProvider = new TestProvider();

describe('server/lib/kyc/base', () => {
  describe('revoke', () => {
    beforeEach(async () => {
      await resetTestDB();
    });
    it('marks the verification as REVOKED', async () => {
      const org = await fakeOrganization();
      const user = await fakeUser();
      const kycVerification = await fakeKYCVerification({
        provider: KYCProviderName.MANUAL,
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: org.id,
        status: KYCVerificationStatus.VERIFIED,
      });

      await testProvider.revoke(kycVerification);

      await kycVerification.reload();
      expect(kycVerification.status).to.equal(KYCVerificationStatus.REVOKED);
    });
  });
});
