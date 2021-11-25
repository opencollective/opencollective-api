import { GraphQLInt, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { Amount } from './Amount';
import { TimeSeriesAmount } from './TimeSeriesAmount';

export const ContributionStats = new GraphQLObjectType({
  name: 'ContributionStats',
  description: 'Contribution statistics related to the given accounts',
  fields: () => ({
    contributionsCount: { type: new GraphQLNonNull(GraphQLInt), description: 'The total number of contributions' },
    contributionAmountOverTime: {
      type: TimeSeriesAmount,
      description: 'The contribution amounts over time',
    },
    oneTimeContributionsCount: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Number of one time contributions',
    },
    recurringContributionsCount: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Number of recurring contributions',
    },
    dailyAverageIncomeAmount: { type: new GraphQLNonNull(Amount), description: 'The daily average income' },
  }),
});
