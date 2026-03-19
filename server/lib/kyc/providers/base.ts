import ActivityTypes from '../../../constants/activities';
import Activity from '../../../models/Activity';
import { KYCVerification, KYCVerificationStatus } from '../../../models/KYCVerification';
import { reportErrorToSentry } from '../../sentry';
import {
  handleExpenseKycRequested,
  handleExpenseKycRevoked,
  handleExpenseKycVerified,
} from '../expenses/kyc-expenses-check';

import { KYCProviderName } from '.';

export type KYCRequest = {
  CollectiveId: number;
  RequestedByCollectiveId: number;
  CreatedByUserId: number;
  UserTokenId: number | null;
};

export type ProviderKYCRequestBase = {
  UserTokenId: number | null;
};

export abstract class KYCProvider<
  ProviderKYCRequest extends ProviderKYCRequestBase,
  ProviderKYCVerification extends KYCVerification = KYCVerification,
> {
  providerName: KYCProviderName;

  constructor(providerName: KYCProviderName) {
    this.providerName = providerName;
  }

  protected abstract requestVerification(
    params: KYCRequest,
    providerParams: ProviderKYCRequest,
  ): Promise<ProviderKYCVerification>;

  protected async handleKycRequested(kycVerification: ProviderKYCVerification, providerParams: ProviderKYCRequest) {
    await this.createRequestedActivity(kycVerification, providerParams.UserTokenId);
    try {
      await handleExpenseKycRequested(kycVerification);
    } catch (error) {
      reportErrorToSentry(error);
    }
  }

  protected async handleKycVerified(kycVerification: ProviderKYCVerification) {
    await Activity.create({
      type: ActivityTypes.KYC_VERIFIED,
      CollectiveId: kycVerification.CollectiveId,
      FromCollectiveId: kycVerification.RequestedByCollectiveId,
      HostCollectiveId: kycVerification.RequestedByCollectiveId,
      data: this.activityData(kycVerification),
    });

    try {
      await handleExpenseKycVerified(kycVerification);
    } catch (error) {
      reportErrorToSentry(error);
    }
  }

  protected async handleKycRevoked(
    kycVerification: ProviderKYCVerification,
    userId: number,
    userTokenId: number | null,
  ) {
    await Activity.create({
      type: ActivityTypes.KYC_REVOKED,
      CollectiveId: kycVerification.CollectiveId,
      FromCollectiveId: kycVerification.RequestedByCollectiveId,
      HostCollectiveId: kycVerification.RequestedByCollectiveId,
      UserId: userId,
      UserTokenId: userTokenId,
      data: this.activityData(kycVerification),
    });

    try {
      await handleExpenseKycRevoked(kycVerification);
    } catch (error) {
      reportErrorToSentry(error);
    }
  }

  async revoke(
    kycVerification: ProviderKYCVerification,
    userId: number,
    userTokenId: number | null,
  ): Promise<ProviderKYCVerification> {
    const res = await kycVerification.update({
      status: KYCVerificationStatus.REVOKED,
      revokedAt: new Date(),
    });

    await this.handleKycRevoked(kycVerification, userId, userTokenId);

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
      id: kycVerification.id,
      provider: kycVerification.provider,
      verifiedAt: kycVerification.verifiedAt,
      revokedAt: kycVerification.revokedAt,
    };
  }
}
