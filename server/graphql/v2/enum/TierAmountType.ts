import { GraphQLEnumType } from 'graphql';

export const GraphQLTierAmountType = new GraphQLEnumType({
  name: 'TierAmountType',
  values: {
    FIXED: {},
    FLEXIBLE: {},
  },
});
