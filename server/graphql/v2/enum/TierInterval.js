import { GraphQLEnumType } from 'graphql';

export const TierInterval = new GraphQLEnumType({
  name: 'TierInterval',
  values: {
    month: {},
    year: {},
  },
});
