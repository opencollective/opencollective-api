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
  async revoke(kycVerification: ProviderKYCVerification): Promise<ProviderKYCVerification> {
    return kycVerification.update({
      status: KYCVerificationStatus.REVOKED,
    });
  }
}
