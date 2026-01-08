import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString, GraphQLUnionType } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';

import { KYCProviderName } from '../../../lib/kyc/providers';
import { KYCVerification } from '../../../models/KYCVerification';
import { GraphQLKYCProvider } from '../enum/KYCProvider';
import { GraphQLKYCVerificationStatus } from '../enum/KYCVerificationStatus';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';

import { GraphQLKYCVerificationPermissions } from './KYCVerificationPermissions';

export const GraphQLKYCVerification = new GraphQLObjectType({
  name: 'KYCVerification',
  description: 'A KYC Verification',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this KYC verification',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.KYC_VERIFICATION),
    },
    provider: {
      description: 'Provider used to make this KYC verification',
      type: new GraphQLNonNull(GraphQLKYCProvider),
    },
    requestedByAccount: {
      description: 'The account that requested the KYC verification',
      type: new GraphQLNonNull(GraphQLAccount),
      resolve(kycVerification: KYCVerification, _, req: Express.Request) {
        return req.loaders.Collective.byId.load(kycVerification.RequestedByCollectiveId);
      },
    },
    account: {
      description: 'The account that is verified',
      type: new GraphQLNonNull(GraphQLAccount),
      resolve(kycVerification: KYCVerification, _, req: Express.Request) {
        return req.loaders.Collective.byId.load(kycVerification.CollectiveId);
      },
    },
    createdByUser: {
      description: 'The user who added this account to the KYC verification list',
      type: GraphQLAccount,
      resolve(kycVerification: KYCVerification, _, req: Express.Request) {
        if (kycVerification.CreatedByUserId) {
          return req.loaders.Collective.byUserId.load(kycVerification.CreatedByUserId);
        }
        return null;
      },
    },
    providerData: {
      description: 'Provider specific data',
      type: new GraphQLNonNull(GraphQLKYCProviderData),
      resolve(kycVerification, _, req: Express.Request) {
        const hasAccess =
          req.remoteUser?.isAdmin(kycVerification.RequestedByCollectiveId) ||
          req.remoteUser?.isAdmin(kycVerification.CollectiveId);
        if (!hasAccess) {
          return null;
        }
        return kycVerification;
      },
    },
    verifiedData: {
      description: 'Verified KYC data',
      type: new GraphQLNonNull(GraphQLKYCVerifiedData),
      resolve(kycVerification, _, req: Express.Request) {
        const hasAccess =
          req.remoteUser?.isAdmin(kycVerification.RequestedByCollectiveId) ||
          req.remoteUser?.isAdmin(kycVerification.CollectiveId);
        if (!hasAccess) {
          return null;
        }
        return kycVerification.data;
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
    permissions: {
      type: new GraphQLNonNull(GraphQLKYCVerificationPermissions),
      resolve: kycVerification => kycVerification,
    },
  }),
});

const GraphQLKYCVerifiedData = new GraphQLObjectType({
  name: 'KYCVerifiedData',
  description: 'Verified KYC data',
  fields: () => ({
    legalName: {
      type: GraphQLString,
      description: 'Account legal name as verified by KYC',
    },
    legalAddress: {
      type: GraphQLString,
      description: 'Account legal address as verified by KYC',
    },
  }),
});

const GraphQLManualKYCProviderData = new GraphQLObjectType({
  name: 'ManualKYCProviderData',
  description: 'Manual KYC data',
  fields: () => ({
    notes: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Notes added during manual verification',
      resolve(kycVerification: KYCVerification<KYCProviderName.MANUAL>) {
        return kycVerification.providerData.notes;
      },
    },
  }),
});

const GraphQLPersonaKYCProviderData = new GraphQLObjectType({
  name: 'PersonaKYCProviderData',
  description: 'Persona KYC data',
  fields: () => ({
    imported: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether this persona inquiry was imported',
      resolve(kycVerification: KYCVerification<KYCProviderName.PERSONA>) {
        return !!kycVerification.providerData.imported;
      },
    },
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'ID of the Persona inquiry',
      resolve(kycVerification: KYCVerification<KYCProviderName.PERSONA>) {
        return kycVerification.providerData.inquiry.id;
      },
    },
    status: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Status of the Persona inquiry',
      resolve(kycVerification: KYCVerification<KYCProviderName.PERSONA>) {
        return kycVerification.providerData.inquiry.attributes.status;
      },
    },
    fields: {
      type: new GraphQLNonNull(GraphQLJSON),
      description: 'Contains KYC data verified by this inquiry',
      resolve(kycVerification: KYCVerification<KYCProviderName.PERSONA>) {
        return kycVerification.providerData.inquiry.attributes.fields;
      },
    },
  }),
});

const GraphQLKYCProviderData = new GraphQLUnionType({
  name: 'KYCProviderData',
  types: [GraphQLManualKYCProviderData, GraphQLPersonaKYCProviderData],
  resolveType(kycVerification: KYCVerification) {
    switch (kycVerification.provider) {
      case KYCProviderName.MANUAL:
        return 'ManualKYCProviderData';
      case KYCProviderName.PERSONA:
        return 'PersonaKYCProviderData';
    }
  },
});
