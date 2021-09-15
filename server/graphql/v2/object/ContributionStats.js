import { GraphQLInt, GraphQLObjectType } from 'graphql';

export const ContributionStats = new GraphQLObjectType({
  name: 'ContributionStats',
  description: 'Contribution statistics related to the given accounts',
  fields: () => ({
    numContributions: { type: GraphQLInt, description: 'The total number of contributions' },
    numOneTime: { type: GraphQLInt, description: 'Number of one time contributions' },
    numRecurring: { type: GraphQLInt, description: 'Number of recurring contributions' },
    dailyAvgIncome: { type: GraphQLInt, description: 'The daily average income' },
  }),
});
