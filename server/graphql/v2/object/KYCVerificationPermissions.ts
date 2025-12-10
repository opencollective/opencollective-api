import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { canRevokeKYCVerification } from '../../../lib/kyc/permissions';
import { KYCVerification } from '../../../models/KYCVerification';

export const GraphQLKYCVerificationPermissions = new GraphQLObjectType({
  name: 'KYCVerificationPermissions',
  description: 'KYC Verification permissions',
  fields: () => ({
    canRevokeKYCVerification: {
      description: 'Whether this KYC Verification can be revoked by the logged in user',
      type: new GraphQLNonNull(GraphQLBoolean),
      resolve(kycVerification: KYCVerification, _, req: Express.Request) {
        return canRevokeKYCVerification(req, kycVerification);
      },
    },
  }),
});
