import { KYCVerification, KYCVerificationStatus } from '../../../models/KYCVerification';

import { KYCProvider, KYCRequest } from './base';
import { KYCProviderName } from '.';

type ManualKYCRequest = {
  legalName: string;
  legalAddress?: string;
  notes?: string;
};

type ManualKYCVerification = KYCVerification<KYCProviderName.MANUAL>;

class ManualKYCProvider extends KYCProvider<ManualKYCRequest, ManualKYCVerification> {
  constructor() {
    super(KYCProviderName.MANUAL);
  }

  async requestVerification(params: KYCRequest, manualParams: ManualKYCRequest): Promise<ManualKYCVerification> {
    const existing = await KYCVerification.findOne({
      where: {
        CollectiveId: params.CollectiveId,
        RequestedByCollectiveId: params.RequestedByCollectiveId,
        provider: this.providerName,
        status: KYCVerificationStatus.VERIFIED,
      },
    });

    if (existing) {
      throw new Error(`Account already verified with this KYC provider`);
    }

    const kycVerification = await KYCVerification.create<ManualKYCVerification>({
      CollectiveId: params.CollectiveId,
      RequestedByCollectiveId: params.RequestedByCollectiveId,
      CreatedByUserId: params.CreatedByUserId,
      providerData: {
        notes: manualParams.notes ?? '',
      },
      data: {
        legalName: manualParams.legalName,
        ...(manualParams.legalAddress ? { legalAddress: manualParams.legalAddress } : {}),
      },
      provider: this.providerName,
      status: KYCVerificationStatus.VERIFIED,
      verifiedAt: new Date(),
    });

    await this.createRequestedActivity(kycVerification, params.UserTokenId);

    return kycVerification;
  }
}

const manualKycProvider = new ManualKYCProvider();

export { manualKycProvider };
