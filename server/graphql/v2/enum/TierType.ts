import { GraphQLEnumType } from 'graphql';

export const GraphQLTierType = new GraphQLEnumType({
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
