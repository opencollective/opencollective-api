import { GraphQLNonNull } from 'graphql';

import { checkFeatureAccess, FEATURE } from '../../../lib/allowed-features';
import { getKYCProvider } from '../../../lib/kyc';
import { Collective } from '../../../models';
import { KYCVerification } from '../../../models/KYCVerification';
import { checkRemoteUserCanUseKYC } from '../../common/scope-check';
import { Forbidden, NotFound } from '../../errors';
import { GraphQLKYCProvider } from '../enum/KYCProvider';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLKYCVerificationReferenceInput } from '../input/KYCVerificationReferenceInput';
import { GraphQLRequestKYCVerificationInput } from '../input/RequestKYCVerificationInput';
import { GraphQLKYCVerification } from '../object/KYCVerification';

const KYCMutations = {
  requestKYCVerification: {
    type: new GraphQLNonNull(GraphQLKYCVerification),
    description: 'Requests an account to be verified using a KYC provider',
    args: {
      requestedByAccount: {
        description: 'Account request KYC Verification',
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      },
      verifyAccount: {
        description: 'Account that will be verified',
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      },
      provider: {
        type: new GraphQLNonNull(GraphQLKYCProvider),
      },
      request: {
        description: 'Provider specific request data',
        type: new GraphQLNonNull(GraphQLRequestKYCVerificationInput),
      },
    },
    async resolve(_, args, req: Express.Request): Promise<KYCVerification> {
      checkRemoteUserCanUseKYC(req);
      const requestedByAccount = await fetchAccountWithReference(args.requestedByAccount, { throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(requestedByAccount)) {
        throw new Forbidden();
      }

      await checkFeatureAccess(requestedByAccount, FEATURE.KYC);

      const verifyAccount = await fetchAccountWithReference(args.verifyAccount, { throwIfMissing: true });

      const provider = getKYCProvider(args.provider);
      const providerRequest = args.request[provider.providerName];

      return await provider.request(
        {
          RequestedByCollectiveId: requestedByAccount.id,
          CollectiveId: verifyAccount.id,
        },
        providerRequest,
      );
    },
  },
  revokeKYCVerification: {
    description: 'Revoke the KYC Verification',
    type: new GraphQLNonNull(GraphQLKYCVerification),
    args: {
      kycVerification: { type: new GraphQLNonNull(GraphQLKYCVerificationReferenceInput) },
    },
    async resolve(_, args, req: Express.Request): Promise<KYCVerification> {
      checkRemoteUserCanUseKYC(req);

      const kycVerification = await KYCVerification.findOne({
        where: {
          id: args.kycVerification,
        },
        include: [
          {
            as: 'requestedByCollective',
            model: Collective,
          },
        ],
      });

      if (!kycVerification) {
        throw new NotFound('KYC Verification not found');
      }

      if (!req.remoteUser.isAdminOfCollective(kycVerification.requestedByCollective)) {
        throw new Forbidden();
      }

      const provider = getKYCProvider(kycVerification.provider);
      return provider.revoke(kycVerification);
    },
  },
};

export default KYCMutations;
