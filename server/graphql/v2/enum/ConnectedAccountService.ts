import { GraphQLEnumType } from 'graphql';

import { Service } from '../../../constants/connected-account';

const deprecatedValues = new Set([Service.MEETUP, Service.PRIVACY]);

export const GraphQLConnectedAccountService = new GraphQLEnumType({
  name: 'ConnectedAccountService',
  description: 'All supported services a user can connect with',
  values: Object.values(Service).reduce(
    (values, key) => ({
      ...values,
      [key]: {
        value: key,
        deprecationReason: deprecatedValues.has(key) ? 'Not using this service anymore' : undefined,
      },
    }),
    {},
  ),
});
