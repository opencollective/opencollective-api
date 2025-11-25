import { GraphQLEnumType } from 'graphql';

import { KYCProviderName } from '../../../models/KYCVerification';

export const GraphQLKYCProvider = new GraphQLEnumType({
  name: 'KYCProvider',
  values: Object.keys(KYCProviderName).reduce((acc, key) => {
    return {
      ...acc,
      [key]: {
        value: KYCProviderName[key],
      },
    };
  }, {}),
});
