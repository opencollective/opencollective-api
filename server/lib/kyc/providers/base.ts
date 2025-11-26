import ActivityTypes from '../../../constants/activities';
import Activity from '../../../models/Activity';
import { KYCProviderName, KYCVerification, KYCVerificationStatus } from '../../../models/KYCVerification';

export type KYCRequest = {
  CollectiveId: number;
  RequestedByCollectiveId: number;
};

export abstract class KYCProvider<
  ProviderKYCRequest,
  ProviderKYCVerification extends KYCVerification = KYCVerification,
> {
  providerName: KYCProviderName;

  constructor(providerName: KYCProviderName) {
    this.providerName = providerName;
  }

  abstract request(req: KYCRequest, providerRequest: ProviderKYCRequest): Promise<ProviderKYCVerification>;
  abstract getVerifiedName(kycVerification: ProviderKYCVerification): string;
  abstract getVerifiedAddress(kycVerification: ProviderKYCVerification): string;

  async revoke(kycVerification: ProviderKYCVerification): Promise<ProviderKYCVerification> {
    const res = await kycVerification.update({
      status: KYCVerificationStatus.REVOKED,
    });

    await Activity.create({
      type: ActivityTypes.KYC_REVOKED,
      CollectiveId: kycVerification.CollectiveId,
      FromCollectiveId: kycVerification.RequestedByCollectiveId,
      data: this.activityData(kycVerification),
    });

    return res;
  }

  protected async createRequestedActivity(kycVerification: ProviderKYCVerification) {
    await Activity.create({
      type: ActivityTypes.KYC_REQUESTED,
      CollectiveId: kycVerification.CollectiveId,
      FromCollectiveId: kycVerification.RequestedByCollectiveId,
      data: this.activityData(kycVerification),
    });
  }

  protected activityData(kycVerification: ProviderKYCVerification): Record<string, unknown> {
    return {
      provider: kycVerification.provider,
      verifiedAt: kycVerification.verifiedAt,
      revokedAt: kycVerification.revokedAt,
    };
  }
}
