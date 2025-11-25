import { KYCProviderName, KYCVerification, KYCVerificationStatus } from '../../../models/KYCVerification';

import { KYCProvider, KYCRequest } from './base';

type ManualKYCRequest = {
  legalAddress: string;
  legalName: string;
  notes?: string;
};

type ManualKYCVerification = KYCVerification<KYCProviderName.MANUAL>;

class ManualKYCProvider extends KYCProvider<ManualKYCRequest> {
  constructor() {
    super(KYCProviderName.MANUAL);
  }

  async request(req: KYCRequest, providerRequest: ManualKYCRequest): Promise<KYCVerification> {
    const kycVerification = KYCVerification.create({
      CollectiveId: req.CollectiveId,
      RequestedByCollectiveId: req.RequestedByCollectiveId,
      data: {
        providerData: {
          legalAddress: providerRequest.legalAddress,
          legalName: providerRequest.legalName,
          notes: providerRequest.notes ?? '',
        },
      },
      provider: KYCProviderName.MANUAL,
      status: KYCVerificationStatus.VERIFIED,
      verifiedAt: new Date(),
    });
    return kycVerification;
  }
}

const manualKycProvider = new ManualKYCProvider();

export { manualKycProvider };
