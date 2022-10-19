import { GraphQLEnumType } from 'graphql';

export const TierType = new GraphQLEnumType({
  name: 'TierType',
  values: {
    TIER: {},
    MEMBERSHIP: {},
    DONATION: {},
    SINGLE_TICKET: {},
    MULTIPLE_TICKET: {},
    SERVICE: {},
    PRODUCT: {},
  },
});
