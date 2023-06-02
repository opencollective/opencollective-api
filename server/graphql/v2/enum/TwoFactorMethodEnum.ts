import { GraphQLEnumType } from 'graphql';

import { TwoFactorMethod } from '../../../lib/two-factor-authentication';

export const GraphQLTwoFactorMethodEnum = new GraphQLEnumType({
  name: 'TwoFactorMethod',
  description: 'A two factor authentication method',
  values: Object.keys(TwoFactorMethod)
    .filter(v => v !== 'RECOVERY_CODE')
    .reduce((acc, key) => {
      return {
        ...acc,
        [key]: {
          value: TwoFactorMethod[key],
        },
      };
    }, {}),
});
