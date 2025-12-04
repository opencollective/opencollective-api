import { GraphQLEnumType } from 'graphql';

import { KYCVerificationStatus } from '../../../models/KYCVerification';

export const GraphQLKYCVerificationStatus = new GraphQLEnumType({
  name: 'KYCVerificationStatus',
  values: Object.keys(KYCVerificationStatus).reduce((acc, key) => {
    return {
      ...acc,
      [key]: {
        value: KYCVerificationStatus[key],
      },
    };
  }, {}),
});
