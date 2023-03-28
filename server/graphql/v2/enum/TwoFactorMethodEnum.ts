import { GraphQLEnumType } from 'graphql';

import { TwoFactorMethod } from '../../../lib/two-factor-authentication';

export const TwoFactorMethodEnum = new GraphQLEnumType({
  name: 'TwoFactorMethod',
  description: 'A two factor authentication method',
  values: Object.keys(TwoFactorMethod)
    .filter(v => v !== 'RECOVERY_CODE')
    .reduce((acc, key) => {
      return {
        ...acc,
        [TwoFactorMethod[key]]: {
          value: TwoFactorMethod[key],
        },
      };
    }, {}),
});
