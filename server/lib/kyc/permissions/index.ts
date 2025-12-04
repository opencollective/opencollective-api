import { KYCVerification, KYCVerificationStatus } from '../../../models/KYCVerification';

export function canRevokeKYCVerification(req: Express.Request, kycVerification: KYCVerification) {
  return (
    kycVerification.status === KYCVerificationStatus.VERIFIED &&
    req?.remoteUser?.isAdmin(kycVerification.RequestedByCollectiveId)
  );
}
