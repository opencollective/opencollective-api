import { GraphQLEnumType, GraphQLEnumTypeConfig } from 'graphql';

export const GraphQLTierInterval = new GraphQLEnumType({
  name: 'TierInterval',
  // Supported by `GraphQLEnumType` at runtime but missing from its TypeScript config type
  deprecationReason: '2022-05-12: Deprecating in favor of TierFrequency',
  values: {
    month: {},
    year: {},
    flexible: {},
  },
} as GraphQLEnumTypeConfig);
