import { KYCProviderName, KYCVerification, KYCVerificationStatus } from '../../../models/KYCVerification';

import { KYCProvider, KYCRequest } from './base';

type ManualKYCRequest = {
  legalAddress: string;
  legalName: string;
  notes?: string;
};

type ManualKYCVerification = KYCVerification<KYCProviderName.MANUAL>;

class ManualKYCProvider extends KYCProvider<ManualKYCRequest, ManualKYCVerification> {
  constructor() {
    super(KYCProviderName.MANUAL);
  }

  async request(req: KYCRequest, providerRequest: ManualKYCRequest): Promise<ManualKYCVerification> {
    const existing = await KYCVerification.findOne({
      where: {
        CollectiveId: req.CollectiveId,
        RequestedByCollectiveId: req.RequestedByCollectiveId,
        provider: this.providerName,
        status: KYCVerificationStatus.VERIFIED,
      },
    });

    if (existing) {
      throw new Error(`Account already verified with ${this.providerName} provider`);
    }

    const kycVerification = await KYCVerification.create<ManualKYCVerification>({
      CollectiveId: req.CollectiveId,
      RequestedByCollectiveId: req.RequestedByCollectiveId,
      providerData: {
        notes: providerRequest.notes ?? '',
      },
      data: {
        legalAddress: providerRequest.legalAddress,
        legalName: providerRequest.legalName,
      },
      provider: this.providerName,
      status: KYCVerificationStatus.VERIFIED,
      verifiedAt: new Date(),
    });

    await this.createRequestedActivity(kycVerification);

    return kycVerification;
  }
}

const manualKycProvider = new ManualKYCProvider();

export { manualKycProvider };
