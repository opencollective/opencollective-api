import { GraphQLEnumType, GraphQLEnumValueConfig } from 'graphql';

import INTERVALS from '../../../constants/intervals';

export type GraphQLContributionFrequencyType = 'MONTHLY' | 'YEARLY' | 'ONETIME';

export const GraphQLContributionFrequency = new GraphQLEnumType({
  name: 'ContributionFrequency',
  values: {
    MONTHLY: {},
    YEARLY: {},
    ONETIME: {},
  } satisfies Record<GraphQLContributionFrequencyType, GraphQLEnumValueConfig>,
});

/**
 * From an order frequency provided as `ContributionFrequency` GQLV2 enum, returns an interval
 * as we use it in the DB (ie. MONTHLY => month)
 */
export const getIntervalFromContributionFrequency = (input: string): INTERVALS | null => {
  switch (input) {
    case 'MONTHLY':
      return INTERVALS.MONTH;
    case 'YEARLY':
      return INTERVALS.YEAR;
    default:
      return null;
  }
};
