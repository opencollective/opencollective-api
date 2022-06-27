import { GraphQLEnumType } from 'graphql';

export const TierInterval = new GraphQLEnumType({
  name: 'TierInterval',
  deprecationReason: '2022-05-12: Deprecating in favor of TierFrequency',
  values: {
    month: {},
    year: {},
    flexible: {},
  },
});
