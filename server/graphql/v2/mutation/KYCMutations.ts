import { GraphQLNonNull } from 'graphql';

import { getKYCProvider } from '../../../lib/kyc';
import { KYCVerification } from '../../../models/KYCVerification';
import { checkRemoteUserCanUseKYC } from '../../common/scope-check';
import { Forbidden } from '../../errors';
import { GraphQLKYCProvider } from '../enum/KYCProvider';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
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
};

export default KYCMutations;
