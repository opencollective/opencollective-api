import { expect } from 'chai';
import sinon from 'sinon';

import ActivityTypes from '../../../../server/constants/activities';
import * as kycExpensesCheck from '../../../../server/lib/kyc/expenses/kyc-expenses-check';
import { KYCProviderName } from '../../../../server/lib/kyc/providers';
import { KYCProvider, ProviderKYCRequestBase } from '../../../../server/lib/kyc/providers/base';
import Activity from '../../../../server/models/Activity';
import { KYCVerification, KYCVerificationStatus } from '../../../../server/models/KYCVerification';
import { fakeKYCVerification, fakeOrganization, fakeUser } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

class TestProvider extends KYCProvider<ProviderKYCRequestBase> {
  constructor() {
    super('test' as KYCProviderName);
  }

  requestVerification(): Promise<KYCVerification> {
    throw new Error('Method not implemented.');
  }

  async triggerKycRequested(kycVerification: KYCVerification, providerParams: ProviderKYCRequestBase) {
    return this.handleKycRequested(kycVerification, providerParams);
  }

  async triggerKycRevoked(kycVerification: KYCVerification, userId: number, userTokenId: number | null) {
    return this.handleKycRevoked(kycVerification, userId, userTokenId);
  }

  async triggerKycVerified(kycVerification: KYCVerification) {
    return this.handleKycVerified(kycVerification);
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

      await testProvider.revoke(kycVerification, user.id, null);

      await kycVerification.reload();
      expect(kycVerification.status).to.equal(KYCVerificationStatus.REVOKED);

      const activity = await Activity.findOne({
        where: {
          type: ActivityTypes.KYC_REVOKED,
          CollectiveId: kycVerification.CollectiveId,
          FromCollectiveId: kycVerification.RequestedByCollectiveId,
          HostCollectiveId: kycVerification.RequestedByCollectiveId,
        },
      });
      expect(activity).to.exist;
      expect(activity.UserId).to.equal(user.id);
      expect(activity.UserTokenId).to.equal(null);
    });
  });

  describe('handleKycRequested', () => {
    let sandbox: sinon.SinonSandbox;
    beforeEach(async () => {
      await resetTestDB();
      sandbox = sinon.createSandbox();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('creates an activity', async () => {
      const org = await fakeOrganization();
      const user = await fakeUser();
      const kycVerification = await fakeKYCVerification({
        provider: KYCProviderName.MANUAL,
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: org.id,
        status: KYCVerificationStatus.VERIFIED,
      });
      await testProvider.triggerKycRequested(kycVerification, { UserTokenId: null });
      const activity = await Activity.findOne({
        where: {
          type: ActivityTypes.KYC_REQUESTED,
          CollectiveId: kycVerification.CollectiveId,
          FromCollectiveId: kycVerification.RequestedByCollectiveId,
          HostCollectiveId: kycVerification.RequestedByCollectiveId,
        },
      });
      expect(activity).to.exist;
    });

    it('triggers the expense kyc requested handler', async () => {
      const handleExpenseKycRequestedStub = sandbox.stub(kycExpensesCheck, 'handleExpenseKycRequested').resolves();

      const org = await fakeOrganization();
      const user = await fakeUser();
      const kycVerification = await fakeKYCVerification({
        provider: KYCProviderName.MANUAL,
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: org.id,
        status: KYCVerificationStatus.VERIFIED,
      });
      await testProvider.triggerKycRequested(kycVerification, { UserTokenId: null });

      expect(handleExpenseKycRequestedStub).to.have.been.calledWith(kycVerification);
    });
  });

  describe('handleKycRevoked', () => {
    let sandbox: sinon.SinonSandbox;
    beforeEach(async () => {
      await resetTestDB();
      sandbox = sinon.createSandbox();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('creates an activity', async () => {
      const orgAdmin = await fakeUser();
      const org = await fakeOrganization({ admins: [orgAdmin] });
      const user = await fakeUser();
      const kycVerification = await fakeKYCVerification({
        provider: KYCProviderName.MANUAL,
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: org.id,
        status: KYCVerificationStatus.REVOKED,
      });
      await testProvider.triggerKycRevoked(kycVerification, orgAdmin.id, null);
      const activity = await Activity.findOne({
        where: {
          type: ActivityTypes.KYC_REVOKED,
          CollectiveId: kycVerification.CollectiveId,
          FromCollectiveId: kycVerification.RequestedByCollectiveId,
          HostCollectiveId: kycVerification.RequestedByCollectiveId,
        },
      });
      expect(activity).to.exist;
    });

    it('triggers the expense kyc requested handler', async () => {
      const handleExpenseKycRevokedStub = sandbox.stub(kycExpensesCheck, 'handleExpenseKycRevoked').resolves();

      const orgAdmin = await fakeUser();
      const org = await fakeOrganization({ admins: [orgAdmin] });
      const user = await fakeUser();
      const kycVerification = await fakeKYCVerification({
        provider: KYCProviderName.MANUAL,
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: org.id,
        status: KYCVerificationStatus.REVOKED,
      });
      await testProvider.triggerKycRevoked(kycVerification, orgAdmin.id, null);

      expect(handleExpenseKycRevokedStub).to.have.been.calledWith(kycVerification);
    });
  });

  describe('handleKycVerified', () => {
    let sandbox: sinon.SinonSandbox;
    beforeEach(async () => {
      await resetTestDB();
      sandbox = sinon.createSandbox();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('creates an activity', async () => {
      const org = await fakeOrganization();
      const user = await fakeUser();
      const kycVerification = await fakeKYCVerification({
        provider: KYCProviderName.MANUAL,
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: org.id,
        status: KYCVerificationStatus.VERIFIED,
      });
      await testProvider.triggerKycVerified(kycVerification);
      const activity = await Activity.findOne({
        where: {
          type: ActivityTypes.KYC_VERIFIED,
          CollectiveId: kycVerification.CollectiveId,
          FromCollectiveId: kycVerification.RequestedByCollectiveId,
          HostCollectiveId: kycVerification.RequestedByCollectiveId,
        },
      });
      expect(activity).to.exist;
    });

    it('triggers the expense kyc requested handler', async () => {
      const handleExpenseKycVerifiedStub = sandbox.stub(kycExpensesCheck, 'handleExpenseKycVerified').resolves();

      const org = await fakeOrganization();
      const user = await fakeUser();
      const kycVerification = await fakeKYCVerification({
        provider: KYCProviderName.MANUAL,
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: org.id,
        status: KYCVerificationStatus.VERIFIED,
      });
      await testProvider.triggerKycVerified(kycVerification);

      expect(handleExpenseKycVerifiedStub).to.have.been.calledWith(kycVerification);
    });
  });
});
