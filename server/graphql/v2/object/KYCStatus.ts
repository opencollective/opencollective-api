import { GraphQLObjectType } from 'graphql';

import { KYCProviderName } from '../../../lib/kyc/providers';

import { GraphQLKYCVerification } from './KYCVerification';

export const GraphQLKYCStatus = new GraphQLObjectType({
  name: 'KYCStatus',
  description: 'A individual KYC verified status',
  fields: () =>
    Object.fromEntries(Object.values(KYCProviderName).map(provider => [provider, { type: GraphQLKYCVerification }])),
});
