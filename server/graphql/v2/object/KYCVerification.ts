import { GraphQLNonNull, GraphQLObjectType, GraphQLString, GraphQLUnionType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { KYCProviderName, KYCVerification } from '../../../models/KYCVerification';
import { GraphQLKYCProvider } from '../enum/KYCProvider';
import { GraphQLKYCVerificationStatus } from '../enum/KYCVerificationStatus';
import { GraphQLAccount } from '../interface/Account';

export const GraphQLKYCVerification = new GraphQLObjectType({
  name: 'KYCVerification',
  description: 'A KYC Verification',
  fields: () => ({
    provider: {
      type: new GraphQLNonNull(GraphQLKYCProvider),
    },
    requestedByAccount: {
      type: new GraphQLNonNull(GraphQLAccount),
      resolve(kycVerification: KYCVerification, _, req: Express.Request) {
        return req.loaders.Collective.byId.load(kycVerification.RequestedByCollectiveId);
      },
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccount),
      resolve(kycVerification: KYCVerification, _, req: Express.Request) {
        return req.loaders.Collective.byId.load(kycVerification.CollectiveId);
      },
    },
    providerData: {
      type: new GraphQLNonNull(GraphQLKYCProviderData),
      async resolve(kycVerification, _, req: Express.Request) {
        const isRequesterAdmin = req.remoteUser?.isAdmin(kycVerification.RequestedByCollectiveId);
        if (!isRequesterAdmin) {
          return null;
        }
        return kycVerification;
      },
    },
    status: {
      type: new GraphQLNonNull(GraphQLKYCVerificationStatus),
    },
    requestedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      resolve: ({ createdAt }) => createdAt,
    },
    revokedAt: {
      type: GraphQLDateTime,
      resolve: ({ revokedAt }) => revokedAt,
    },
    verifiedAt: {
      type: GraphQLDateTime,
      resolve: ({ verifiedAt }) => verifiedAt,
    },
  }),
});

const GraphQLManualKYCProviderData = new GraphQLObjectType({
  name: 'ManualKYCProviderData',
  description: 'Manual KYC data',
  fields: () => ({
    legalName: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Account legal name as verified by manual KYC',
      resolve(kycVerification: KYCVerification<KYCProviderName.MANUAL>) {
        return kycVerification.data.providerData.legalName;
      },
    },
    legalAddress: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Account legal address as verified by manual KYC',
      resolve(kycVerification: KYCVerification<KYCProviderName.MANUAL>) {
        return kycVerification.data.providerData.legalAddress;
      },
    },
    notes: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Account legal address as verified by manual KYC',
      resolve(kycVerification: KYCVerification<KYCProviderName.MANUAL>) {
        return kycVerification.data.providerData.notes;
      },
    },
  }),
});

const GraphQLKYCProviderData = new GraphQLUnionType({
  name: 'KYCProviderData',
  types: [GraphQLManualKYCProviderData],
  resolveType(kycVerification: KYCVerification) {
    switch (kycVerification.provider) {
      case KYCProviderName.MANUAL:
        return 'ManualKYCProviderData';
    }
  },
});
