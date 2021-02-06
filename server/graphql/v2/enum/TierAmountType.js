import { GraphQLEnumType } from 'graphql';

export const TierAmountType = new GraphQLEnumType({
  name: 'TierAmountType',
  values: {
    FIXED: {},
    FLEXIBLE: {},
  },
});
