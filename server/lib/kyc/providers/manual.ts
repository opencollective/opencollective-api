import { KYCVerification, KYCVerificationStatus } from '../../../models/KYCVerification';

import { KYCProvider, KYCRequest, ProviderKYCRequestBase } from './base';
import { KYCProviderName } from '.';

type ManualKYCRequest = ProviderKYCRequestBase & {
  legalName?: string;
  legalAddress?: string;
  notes?: string;
};

type ManualKYCSubmit = ProviderKYCRequestBase & {
  legalName: string;
  legalAddress?: string;
  notes?: string;
};

type ManualKYCVerification = KYCVerification<KYCProviderName.MANUAL>;

class ManualKYCProvider extends KYCProvider<ManualKYCRequest, ManualKYCSubmit, ManualKYCVerification> {
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

    const existingPending = await KYCVerification.findOne({
      where: {
        CollectiveId: params.CollectiveId,
        RequestedByCollectiveId: params.RequestedByCollectiveId,
        provider: this.providerName,
        status: KYCVerificationStatus.PENDING,
      },
    });

    if (existingPending && !manualParams.legalName) {
      throw new Error(`Account already has a pending KYC verification`);
    }

    const kycVerification = await KYCVerification.create<ManualKYCVerification>({
      CollectiveId: params.CollectiveId,
      RequestedByCollectiveId: params.RequestedByCollectiveId,
      CreatedByUserId: params.CreatedByUserId,
      providerData: {
        notes: manualParams.notes ?? '',
      },
      provider: this.providerName,
      status: KYCVerificationStatus.PENDING,
    });

    await this.handleKycRequested(kycVerification, manualParams);

    return kycVerification;
  }

  async submitVerification(params: KYCRequest, manualParams: ManualKYCSubmit): Promise<ManualKYCVerification> {
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

    let verification = await KYCVerification.findOne({
      where: {
        CollectiveId: params.CollectiveId,
        RequestedByCollectiveId: params.RequestedByCollectiveId,
        provider: this.providerName,
        status: KYCVerificationStatus.PENDING,
      },
    });

    if (verification) {
      await verification.update({
        status: KYCVerificationStatus.VERIFIED,
        verifiedAt: new Date(),
        providerData: {
          ...verification.providerData,
          notes: (manualParams.notes || verification.providerData.notes) ?? '',
        },
        data: {
          ...verification.data,
          legalName: manualParams.legalName,
          ...(manualParams.legalAddress ? { legalAddress: manualParams.legalAddress } : {}),
        },
      });
    } else {
      verification = await KYCVerification.create<ManualKYCVerification>({
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
    }

    await this.handleKycVerified(verification);

    return verification;
  }
}

const manualKycProvider = new ManualKYCProvider();

export { manualKycProvider };
