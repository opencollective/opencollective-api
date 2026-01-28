import ActivityTypes from '../../../constants/activities';
import Activity from '../../../models/Activity';
import { KYCVerification, KYCVerificationStatus } from '../../../models/KYCVerification';

import { KYCProviderName } from '.';

export type KYCRequest = {
  CollectiveId: number;
  RequestedByCollectiveId: number;
  CreatedByUserId: number;
  UserTokenId: number | null;
};

export abstract class KYCProvider<
  ProviderKYCRequest,
  ProviderKYCVerification extends KYCVerification = KYCVerification,
> {
  providerName: KYCProviderName;

  constructor(providerName: KYCProviderName) {
    this.providerName = providerName;
  }

  abstract requestVerification(
    params: KYCRequest,
    providerParams: ProviderKYCRequest,
  ): Promise<ProviderKYCVerification>;

  async revoke(
    kycVerification: ProviderKYCVerification,
    userId: number,
    userTokenId: number | null,
  ): Promise<ProviderKYCVerification> {
    const res = await kycVerification.update({
      status: KYCVerificationStatus.REVOKED,
      revokedAt: new Date(),
    });

    await Activity.create({
      type: ActivityTypes.KYC_REVOKED,
      CollectiveId: kycVerification.CollectiveId,
      FromCollectiveId: kycVerification.RequestedByCollectiveId,
      HostCollectiveId: kycVerification.RequestedByCollectiveId,
      UserId: userId,
      UserTokenId: userTokenId,
      data: this.activityData(kycVerification),
    });

    return res;
  }

  protected async createRequestedActivity(kycVerification: ProviderKYCVerification, userTokenId: number) {
    await Activity.create({
      type: ActivityTypes.KYC_REQUESTED,
      CollectiveId: kycVerification.CollectiveId,
      FromCollectiveId: kycVerification.RequestedByCollectiveId,
      HostCollectiveId: kycVerification.RequestedByCollectiveId,
      UserTokenId: userTokenId,
      UserId: kycVerification.CreatedByUserId,
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
