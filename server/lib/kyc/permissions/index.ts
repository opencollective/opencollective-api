import { KYCVerification, KYCVerificationStatus } from '../../../models/KYCVerification';

export function canRevokeKYCVerification(req: Express.Request, kycVerification: KYCVerification) {
  return (
    [KYCVerificationStatus.VERIFIED, KYCVerificationStatus.PENDING].includes(kycVerification.status) &&
    req?.remoteUser?.isAdmin(kycVerification.RequestedByCollectiveId)
  );
}
