import { GraphQLEnumType } from 'graphql';

export const TierType = new GraphQLEnumType({
  name: 'TierType',
  values: {
    TIER: {},
    MEMBERSHIP: {},
    DONATION: {},
    TICKET: {},
    SERVICE: {},
    PRODUCT: {},
  },
});
