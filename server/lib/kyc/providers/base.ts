import { KYCProviderName, KYCVerification } from '../../../models/KYCVerification';

export type KYCRequest = {
  CollectiveId: number;
  RequestedByCollectiveId: number;
};

export abstract class KYCProvider<ProviderKYCRequest> {
  providerName: KYCProviderName;

  constructor(providerName: KYCProviderName) {
    this.providerName = providerName;
  }

  abstract request(req: KYCRequest, providerRequest: ProviderKYCRequest): Promise<KYCVerification>;
}
