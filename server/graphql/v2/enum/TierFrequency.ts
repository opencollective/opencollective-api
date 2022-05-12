import { GraphQLEnumType } from 'graphql';

export const TierFequency = new GraphQLEnumType({
  name: 'TierFequency',
  values: {
    MONTHLY: {},
    YEARLY: {},
    ONETIME: {},
    FLEXIBLE: {},
  },
});
